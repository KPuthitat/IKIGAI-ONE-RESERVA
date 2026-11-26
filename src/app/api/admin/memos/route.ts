import { NextResponse } from "next/server";
import { logPersonaAction, getDb } from "@/lib/db";
import { listCategories } from "@/lib/accounta-db";
import { CAPEX_CATEGORY_NAME } from "@/lib/accounta";
import { getPr } from "@/lib/purchasing";
import { awaitingMySignature, canSee, cancelMemo, createMemo, getMemoDetail, getSignature, listMemos, MemoError, openPrFromMemo, rejectMemo, reopenMemo, signerChoices, signMemo, submitMemo, updateMemo, type MemoInput } from "@/lib/memos";
import { notifyAuthorApproved, notifyAuthorRejected, notifyPrApprovers, notifySigners } from "@/lib/memo-notify";
import { Body, memoBranches, memoError, memoGate } from "@/lib/memos-api";

// Memo → signatures → PR (owner 2026-11-26).
//   GET            → my memos, the ones waiting for my signature, branches, categories, people I can ask to sign, whether I have a signature
//   GET ?id=<id>   → one memo with items, signers (and their signatures), history
//   POST {action}  → save | submit | reopen | cancel | sign | reject | open_pr
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = memoGate(); if ("error" in g) return g.error;
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (id) {
    try {
      const m = getMemoDetail(id);
      if (!canSee(g.viewer, m)) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ ok: true, memo: m, mySigner: m.signers.find((s) => s.userId === g.user.id) ?? null });
    } catch (e) { return memoError(e); }
  }
  const db = getDb();
  const branches = memoBranches(g.viewer);
  const vendors: Record<number, Array<{ id: number; name: string }>> = {};
  for (const v of db.prepare(`SELECT id, branch_id, name FROM inventa_suppliers WHERE active = 1 AND branch_id IN (${branches.map(() => "?").join(",") || "NULL"}) ORDER BY name`).all(...branches.map((b) => b.id)) as Array<{ id: number; branch_id: number; name: string }>)
    (vendors[v.branch_id] ??= []).push({ id: v.id, name: v.name });
  return NextResponse.json({
    ok: true, me: { userId: g.user.id, hasSignature: !!getSignature(g.user.id), isCLevel: g.viewer.isCLevel, role: g.user.role },
    memos: listMemos(g.viewer), awaiting: awaitingMySignature(g.user.id), branches, vendors,
    categories: listCategories().map((c) => ({ name: c.name, kind: c.name === CAPEX_CATEGORY_NAME ? "capex" : "opex" })), signers: signerChoices().filter((s) => s.id !== g.user.id)
  });
}

export async function POST(req: Request) {
  const g = memoGate(); if ("error" in g) return g.error;
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  const d = p.data, v = g.viewer;
  try {
    switch (d.action) {
      case "save": {
        if (!d.memo) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
        const i: MemoInput = { branchId: d.memo.branch_id, subject: d.memo.subject, body: d.memo.body, category: d.memo.category, neededDate: d.memo.needed_date ?? null, vendorId: d.memo.vendor_id ?? null,
          vendorName: d.memo.vendor_name, vatRate: d.memo.vat_rate, items: d.memo.items, signerIds: d.memo.signer_ids };
        const id = d.memo.id ? (updateMemo(d.memo.id, i, v), d.memo.id) : createMemo(i, v);
        logPersonaAction(g.user.id, d.memo.id ? "memo.update" : "memo.create", id);
        return NextResponse.json({ ok: true, id });
      }
      case "submit": { const m = submitMemo(d.id ?? 0, v); logPersonaAction(g.user.id, "memo.submit", m.id); notifySigners(m); return NextResponse.json({ ok: true, memo: m }); }
      case "reopen": reopenMemo(d.id ?? 0, v); logPersonaAction(g.user.id, "memo.reopen", d.id ?? 0); return NextResponse.json({ ok: true });
      case "cancel": cancelMemo(d.id ?? 0, v); logPersonaAction(g.user.id, "memo.cancel", d.id ?? 0); return NextResponse.json({ ok: true });
      case "sign": {
        const r = signMemo(d.id ?? 0, g.user.id, d.pin ?? "");
        logPersonaAction(g.user.id, "memo.sign", r.memo.id);
        if (r.allSigned) notifyAuthorApproved(r.memo);
        return NextResponse.json({ ok: true, memo: r.memo, allSigned: r.allSigned });
      }
      case "reject": {
        const m = rejectMemo(d.id ?? 0, g.user.id, d.reason ?? "");
        logPersonaAction(g.user.id, "memo.reject", m.id);
        notifyAuthorRejected(m, g.user.display_name, (d.reason ?? "").trim());
        return NextResponse.json({ ok: true, memo: m });
      }
      case "open_pr": {
        const r = openPrFromMemo(d.id ?? 0, v, d.over_budget_reason);
        logPersonaAction(g.user.id, "memo.open_pr", r.memo.id);
        const pr = getPr(r.prId);
        if (pr) notifyPrApprovers(pr, r.memo.memoNo);
        return NextResponse.json({ ok: true, memo: r.memo, prId: r.prId });
      }
    }
  } catch (e) { if (e instanceof MemoError) return memoError(e); throw e; }
}
