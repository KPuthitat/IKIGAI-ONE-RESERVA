import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/persona/employees/[id]/branches
//
// Sets which branches an employee may enter (their user_branches
// membership). This is the staff-access counterpart to the branch
// ADMIN grants done on /admin/companies — so it must NOT clobber
// is_admin: a branch the caller keeps for the user is left exactly
// as it was (is_admin preserved).
//
// Scope: a sub-admin can only add/remove branches they administer
// (user.adminBranchIds). super_admin can touch every branch. Any
// branch outside the caller's scope is left untouched, so a sub-
// admin can never strip access another admin/super_admin granted
// elsewhere.

const Body = z.object({
  branch_ids: z.array(z.number().int().positive()).max(100),
  // Home/primary branch (super_admin only) — FT monthly salary is paid at this
  // branch only (owner 2026-07-14). Must be one of the resulting memberships;
  // ignored for non-super_admin. Omit to leave the current primary as-is.
  primary_branch_id: z.number().int().positive().nullable().optional(),
  // Per-branch PT hourly rate (super_admin only, owner 2026-08-04). Each entry
  // sets/clears user_branches.hourly_rate for one branch (null → default rate).
  // Only applied to branches in the resulting membership + caller's scope.
  // daily_rate (owner 2026-08-17): per-branch CROSS-COMPANY/BRANCH helper day rate
  // — set on a branch of another company the person goes to help; that branch's
  // weekly round then pays rate × วันที่ลงเวลา (WHT 3%, no SSO). null → not a helper
  // there. Only sent for a field the client actually edited.
  rates: z.array(z.object({
    branch_id: z.number().int().positive(),
    hourly_rate: z.number().min(0).max(100000).nullable().optional(),
    daily_rate: z.number().min(0).max(100000).nullable().optional()
  })).max(100).optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const me = getSessionUser();
  if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (me.role !== "admin" && me.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const db = getDb();
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

  // Branches the caller is allowed to change.
  const editable = new Set<number>(
    me.role === "super_admin"
      ? (db.prepare("SELECT id FROM branches").all() as Array<{ id: number }>).map((b) => b.id)
      : me.adminBranchIds
  );
  // Only branches that both exist and are in the caller's scope.
  const desired = new Set<number>(
    parsed.data.branch_ids.filter((b) => editable.has(b))
  );

  const current = new Set<number>(
    (db.prepare(
      "SELECT branch_id FROM user_branches WHERE user_id = ?"
    ).all(id) as Array<{ branch_id: number }>).map((r) => r.branch_id)
  );

  const toAdd: number[] = [];
  const toRemove: number[] = [];
  for (const b of editable) {
    const want = desired.has(b);
    const has = current.has(b);
    if (want && !has) toAdd.push(b);
    else if (!want && has) toRemove.push(b);
    // want && has → leave the row (is_admin preserved)
  }

  // Home/primary branch is a super_admin-only designation (FT salary lands
  // there). A non-super_admin's primary_branch_id is ignored.
  const wantsPrimary = me.role === "super_admin" && parsed.data.primary_branch_id != null
    ? parsed.data.primary_branch_id
    : null;

  // Per-branch rate is super_admin-only (pay-sensitive) and only for branches
  // both in the caller's scope AND in the resulting membership. Everything else
  // is dropped so a sub-admin (rates ignored) or an out-of-scope/unassigned
  // branch can never have a rate written.
  const rateUpdates = me.role === "super_admin"
    ? (parsed.data.rates ?? []).filter((r) => editable.has(r.branch_id) && desired.has(r.branch_id))
    : [];

  if (toAdd.length === 0 && toRemove.length === 0 && wantsPrimary == null && rateUpdates.length === 0) {
    return NextResponse.json({ ok: true, added: 0, removed: 0 });
  }

  const txn = db.transaction(() => {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO user_branches (user_id, branch_id, is_admin) VALUES (?, ?, 0)"
    );
    for (const b of toAdd) ins.run(id, b);
    const del = db.prepare(
      "DELETE FROM user_branches WHERE user_id = ? AND branch_id = ?"
    );
    for (const b of toRemove) del.run(id, b);

    // Normalise the home branch: keep exactly one is_primary=1 among the user's
    // remaining memberships. Prefer the super_admin's explicit pick (when it's
    // still a member), else keep the current primary, else the lowest branch —
    // so an FT never ends up with zero or two home branches.
    const finalRows = db.prepare(
      "SELECT branch_id, is_primary FROM user_branches WHERE user_id = ? ORDER BY branch_id"
    ).all(id) as Array<{ branch_id: number; is_primary: number }>;
    if (finalRows.length > 0) {
      const finalSet = new Set(finalRows.map((r) => r.branch_id));
      const currentPrimary = finalRows.find((r) => r.is_primary === 1)?.branch_id ?? null;
      const primary =
        wantsPrimary != null && finalSet.has(wantsPrimary) ? wantsPrimary
        : currentPrimary != null ? currentPrimary
        : finalRows[0].branch_id;
      db.prepare(
        "UPDATE user_branches SET is_primary = CASE WHEN branch_id = ? THEN 1 ELSE 0 END WHERE user_id = ?"
      ).run(primary, id);
    }

    // Per-branch rate overrides (super_admin). null clears → default rate.
    // Runs after membership changes so a just-added branch row exists to update.
    // Each field is written only when the client actually sent it (partial edits),
    // so setting a helper daily_rate never wipes an existing hourly_rate.
    if (rateUpdates.length > 0) {
      const setHourly = db.prepare(
        "UPDATE user_branches SET hourly_rate = ? WHERE user_id = ? AND branch_id = ?"
      );
      const setDaily = db.prepare(
        "UPDATE user_branches SET daily_rate = ? WHERE user_id = ? AND branch_id = ?"
      );
      for (const r of rateUpdates) {
        if ("hourly_rate" in r) setHourly.run(r.hourly_rate ?? null, id, r.branch_id);
        if ("daily_rate" in r) setDaily.run(r.daily_rate ?? null, id, r.branch_id);
      }
    }
  });
  txn();

  logPersonaAction(me.id, "user.branch_access", id);
  return NextResponse.json({ ok: true, added: toAdd.length, removed: toRemove.length });
}
