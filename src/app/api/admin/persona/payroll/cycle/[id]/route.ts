import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { postPayrollToAccounta, removePayrollFromAccounta } from "@/lib/accounta-db";
import { resolveCompanyCycle } from "@/lib/payroll-cycle";

// POST /api/admin/persona/payroll/cycle/[id]
// Cascade one operation across all sibling per-branch periods of a company
// cycle (owner 2026-07-27). Each operation is the SAME guarded mutation the
// per-period route uses — finalize/pay are plain UPDATEs, post/unpost call the
// idempotent accounta helpers — just applied in a loop. Each period is
// independent: one failure is recorded and the rest continue (a money flow must
// never silently stop halfway). Every period still resolves its OWN branch/
// company inside postPayrollToAccounta, so per-branch books stay split.

const Body = z.object({
  action: z.enum(["finalize_all", "unfinalize_all", "mark_paid_all", "post_all", "unpost_all"]),
  pin: z.string().optional(),
  paid_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

type Result = { period_id: number; branch: string | null; ok: boolean; skipped?: string; error?: string };

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const repId = Number(params.id);
  if (!Number.isInteger(repId) || repId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const db = getDb();
  const resolved = resolveCompanyCycle(db, repId);
  if (!resolved) return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  const { siblings } = resolved;

  const nowIso = new Date().toISOString();
  const results: Result[] = [];

  // ── ปิดยอดทุกสาขา ── needs the admin PIN; verify ONCE before the loop.
  if (d.action === "finalize_all") {
    const pinStr = (d.pin ?? "").trim();
    if (!pinStr) return NextResponse.json({ error: "pin_required", message: "ต้องใส่ PIN ก่อนปิดยอด" }, { status: 400 });
    const pinCheck = verifyAdminPin(user.id, pinStr);
    if (!pinCheck.ok) {
      return NextResponse.json(
        { error: pinCheck.reason, message: pinCheck.reason === "no_pin" ? "ยังไม่ได้ตั้ง PIN" : "PIN ไม่ถูกต้อง" },
        { status: 401 }
      );
    }
    const stmt = db.prepare(`UPDATE payroll_periods SET status='finalized', finalized_by=?, finalized_at=? WHERE id=? AND status='draft'`);
    for (const s of siblings) {
      if (s.status !== "draft") { results.push({ period_id: s.id, branch: s.branch_name, ok: false, skipped: s.status }); continue; }
      try { stmt.run(user.id, nowIso, s.id); results.push({ period_id: s.id, branch: s.branch_name, ok: true }); }
      catch (e) { results.push({ period_id: s.id, branch: s.branch_name, ok: false, error: (e as Error).message }); }
    }
    return NextResponse.json({ ok: true, results });
  }

  // ── ยกเลิกปิดยอดทุกสาขา ── finalized → draft; also roll back any posted รายจ่าย.
  if (d.action === "unfinalize_all") {
    const stmt = db.prepare(`UPDATE payroll_periods SET status='draft', finalized_by=NULL, finalized_at=NULL WHERE id=? AND status='finalized'`);
    for (const s of siblings) {
      if (s.status !== "finalized") { results.push({ period_id: s.id, branch: s.branch_name, ok: false, skipped: s.status }); continue; }
      try {
        stmt.run(s.id);
        try { removePayrollFromAccounta(s.id); } catch (e) { console.error("[payroll-cycle] removePayrollFromAccounta failed", e); }
        results.push({ period_id: s.id, branch: s.branch_name, ok: true });
      } catch (e) { results.push({ period_id: s.id, branch: s.branch_name, ok: false, error: (e as Error).message }); }
    }
    return NextResponse.json({ ok: true, results });
  }

  // ── ทำจ่ายทุกสาขา ── finalized → paid (shared paid_at, backdatable).
  if (d.action === "mark_paid_all") {
    const paidAtIso = d.paid_at
      ? new Date(`${d.paid_at}T12:00:00+07:00`).toISOString()
      : nowIso;
    const stmt = db.prepare(`UPDATE payroll_periods SET status='paid', paid_by=?, paid_at=? WHERE id=? AND status='finalized'`);
    for (const s of siblings) {
      if (s.status !== "finalized") { results.push({ period_id: s.id, branch: s.branch_name, ok: false, skipped: s.status }); continue; }
      try { stmt.run(user.id, paidAtIso, s.id); results.push({ period_id: s.id, branch: s.branch_name, ok: true }); }
      catch (e) { results.push({ period_id: s.id, branch: s.branch_name, ok: false, error: (e as Error).message }); }
    }
    return NextResponse.json({ ok: true, results });
  }

  // ── ลงบัญชีทุกสาขา ── each paid period posts to ITS OWN branch/company books.
  if (d.action === "post_all") {
    const stmt = db.prepare(`UPDATE payroll_periods SET posted_by=?, posted_at=COALESCE(posted_at,?) WHERE id=?`);
    for (const s of siblings) {
      if (s.status !== "paid") { results.push({ period_id: s.id, branch: s.branch_name, ok: false, skipped: s.status }); continue; }
      try {
        postPayrollToAccounta(s.id, user.id);
        stmt.run(user.id, nowIso, s.id);
        results.push({ period_id: s.id, branch: s.branch_name, ok: true });
      } catch (e) { results.push({ period_id: s.id, branch: s.branch_name, ok: false, error: (e as Error).message }); }
    }
    return NextResponse.json({ ok: true, results });
  }

  // ── ยกเลิกลงบัญชีทุกสาขา ── remove posted รายจ่าย + clear posted_at/by.
  if (d.action === "unpost_all") {
    const stmt = db.prepare(`UPDATE payroll_periods SET posted_by=NULL, posted_at=NULL WHERE id=?`);
    for (const s of siblings) {
      if (!(s.status === "paid" && s.posted_at)) { results.push({ period_id: s.id, branch: s.branch_name, ok: false, skipped: "not_posted" }); continue; }
      try {
        removePayrollFromAccounta(s.id);
        stmt.run(s.id);
        results.push({ period_id: s.id, branch: s.branch_name, ok: true });
      } catch (e) { results.push({ period_id: s.id, branch: s.branch_name, ok: false, error: (e as Error).message }); }
    }
    return NextResponse.json({ ok: true, results });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
