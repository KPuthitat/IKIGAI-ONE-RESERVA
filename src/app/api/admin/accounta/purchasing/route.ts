import { NextResponse } from "next/server";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { listCategories } from "@/lib/accounta-db";
import { CAPEX_CATEGORY_NAME } from "@/lib/accounta";
import { noticeFlex, pushIndividually } from "@/lib/special-duty-notify";
import {
  approverRecipients, budgetImpact, cancelPr, createPr, decidePr, getPo, getPr, isApprover, issuePo, linkBills, listItems, listLinkableBills, listLinkedBills, listPrs,
  receivePo, reopenPr, setBudget, submitPr, unlinkBill, updatePr, usageTable, userLine, type PrInput, type PrRow
} from "@/lib/purchasing";
import { Body, purchasingError, purchasingGate, visibleBranches } from "@/lib/purchasing-api";

// Executive purchasing console (owner 2026-10-27): OPEX/CAPEX budgets and PR → approval → PO → receiving → ACCOUNTA bills.
//   GET  ?year=YYYY            → budgets vs spend, PR list, who the viewer is
//   GET  ?id=<prId>            → one PR with items, PO, linked bills, budget impact
//   POST {action, ...}         → save_pr | submit | decide | reopen | cancel | issue_po | receive | link_bills | unlink_bill | set_budget

const baseUrl = () => (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const fmt = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function GET(req: Request) {
  const g = purchasingGate(); if ("error" in g) return g.error;
  const q = new URL(req.url).searchParams;
  const branches = visibleBranches(g.user, g.viewer);
  const ids = branches.map((b) => b.id);

  const prId = Number(q.get("id"));
  if (prId) {
    const pr = getPr(prId);
    if (!pr || !ids.includes(pr.branchId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, pr, items: listItems(prId), po: getPo(prId), bills: listLinkedBills(prId), linkable: ["ordered", "received", "closed"].includes(pr.status) ? listLinkableBills(prId) : [], impact: budgetImpact(pr) });
  }

  const year = Number(q.get("year")) || new Date(Date.now() + 7 * 3600_000).getUTCFullYear();
  const db = getDb();
  const vendors: Record<number, Array<{ id: number; name: string }>> = {};
  for (const v of db.prepare(`SELECT id, branch_id, name FROM inventa_suppliers WHERE active = 1 AND branch_id IN (${ids.map(() => "?").join(",") || "NULL"}) ORDER BY name COLLATE NOCASE`).all(...ids) as Array<{ id: number; branch_id: number; name: string }>)
    (vendors[v.branch_id] ??= []).push({ id: v.id, name: v.name });
  return NextResponse.json({
    ok: true, year,
    me: { userId: g.user.id, isApprover: isApprover(g.viewer), adminBranchIds: g.viewer.adminBranchIds },
    branches, vendors,
    categories: listCategories().map((c) => ({ name: c.name, kind: c.name === CAPEX_CATEGORY_NAME ? "capex" : "opex" })),
    usage: usageTable(year, ids),
    prs: listPrs({ branchIds: ids, year })
  });
}

function notifyApprovers(pr: PrRow) {
  const lines = [`${pr.prNo} · ${pr.branchName}`, pr.title, `${pr.kind === "capex" ? "CAPEX" : "OPEX"} · ${pr.category}`, `ยอดรวม ฿${fmt(pr.total)}${pr.overBudget ? " · เกินงบ" : ""}`, `ผู้ขอ ${pr.requestedByName}`];
  pushIndividually(approverRecipients().map((a) => a.lineUserId), noticeFlex({ title: "มีใบขอซื้อรออนุมัติ", lines, url: `${baseUrl()}/admin/accounta/purchasing?pr=${pr.id}`, button: "เปิดดูและอนุมัติ" }))
    .catch((e) => console.error("purchasing notify approvers", e));
}
function notifyRequester(pr: PrRow) {
  const approved = pr.status === "approved";
  const lines = [`${pr.prNo} · ${pr.title}`, `ยอดรวม ฿${fmt(pr.total)}`, ...(pr.decisionNote ? [`หมายเหตุ: ${pr.decisionNote}`] : []), ...(approved ? ["ออกใบสั่งซื้อ (PO) ได้เลย"] : [])];
  pushIndividually([userLine(pr.requestedBy)], noticeFlex({ title: approved ? "ใบขอซื้อได้รับอนุมัติ" : "ใบขอซื้อไม่ได้รับอนุมัติ", lines, url: `${baseUrl()}/admin/accounta/purchasing?pr=${pr.id}`, button: "เปิดดู" }))
    .catch((e) => console.error("purchasing notify requester", e));
}

export async function POST(req: Request) {
  const g = purchasingGate(); if ("error" in g) return g.error;
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  const d = p.data; const v = g.viewer;
  const pinOk = (): NextResponse | null => {
    const c = verifyAdminPin(g.user.id, (d.pin ?? "").trim());
    return c.ok ? null : NextResponse.json({ error: c.reason, message: c.reason === "no_pin" ? "ยังไม่ได้ตั้ง PIN" : "PIN ไม่ถูกต้อง" }, { status: 401 });
  };
  try {
    switch (d.action) {
      case "save_pr": {
        if (!d.pr) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
        const i: PrInput = { branchId: d.pr.branch_id, category: d.pr.category, title: d.pr.title, reason: d.pr.reason, neededDate: d.pr.needed_date ?? null,
          vendorId: d.pr.vendor_id ?? null, vendorName: d.pr.vendor_name, vatRate: d.pr.vat_rate, overBudgetReason: d.pr.over_budget_reason, items: d.pr.items };
        const id = d.pr.id ? (updatePr(d.pr.id, i, v), d.pr.id) : createPr(i, v);
        logPersonaAction(g.user.id, d.pr.id ? "purchasing.pr.update" : "purchasing.pr.create", id);
        return NextResponse.json({ ok: true, id, impact: budgetImpact(getPr(id)!) });
      }
      case "submit": {
        if (!d.id) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
        const pr = submitPr(d.id, v); notifyApprovers(pr);
        logPersonaAction(g.user.id, "purchasing.pr.submit", d.id);
        return NextResponse.json({ ok: true, overBudget: pr.overBudget });
      }
      case "decide": {
        if (!d.id || d.approve === undefined) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
        if (d.approve) { const bad = pinOk(); if (bad) return bad; }   // approving spends money: PIN
        const pr = decidePr(d.id, d.approve, d.note ?? "", v); notifyRequester(pr);
        logPersonaAction(g.user.id, d.approve ? "purchasing.pr.approve" : "purchasing.pr.reject", d.id);
        return NextResponse.json({ ok: true });
      }
      case "reopen": if (!d.id) return NextResponse.json({ error: "invalid_body" }, { status: 400 }); reopenPr(d.id, v); return NextResponse.json({ ok: true });
      case "cancel": if (!d.id) return NextResponse.json({ error: "invalid_body" }, { status: 400 }); cancelPr(d.id, v); logPersonaAction(g.user.id, "purchasing.pr.cancel", d.id); return NextResponse.json({ ok: true });
      case "issue_po": {
        if (!d.id) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
        const po = issuePo(d.id, { expectedDate: d.expected_date ?? null, note: d.note, vendorName: d.vendor_name }, v);
        logPersonaAction(g.user.id, "purchasing.po.issue", d.id);
        return NextResponse.json({ ok: true, poNo: po.poNo });
      }
      case "receive": if (!d.id) return NextResponse.json({ error: "invalid_body" }, { status: 400 }); receivePo(d.id, d.note ?? "", v); logPersonaAction(g.user.id, "purchasing.po.receive", d.id); return NextResponse.json({ ok: true });
      case "link_bills": if (!d.id || !d.expense_ids?.length) return NextResponse.json({ error: "invalid_body" }, { status: 400 }); linkBills(d.id, d.expense_ids, v); logPersonaAction(g.user.id, "purchasing.po.link", d.id); return NextResponse.json({ ok: true });
      case "unlink_bill": if (!d.id || !d.expense_id) return NextResponse.json({ error: "invalid_body" }, { status: 400 }); unlinkBill(d.id, d.expense_id, v); return NextResponse.json({ ok: true });
      case "set_budget": {
        if (!d.year || !d.budget) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
        if (!isApprover(v)) return NextResponse.json({ error: "forbidden", message: "เฉพาะผู้บริหารตั้งงบได้" }, { status: 403 });
        const bad = pinOk(); if (bad) return bad;
        for (const b of d.budget) setBudget({ year: d.year, branchId: b.branch_id, category: b.category, amount: b.amount, viewer: v });
        logPersonaAction(g.user.id, "purchasing.budget.set", d.year);
        return NextResponse.json({ ok: true });
      }
    }
  } catch (e) { return purchasingError(e); }
}
