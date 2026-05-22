import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction, type Branch } from "@/lib/db";
import { generateWarningRef } from "@/lib/discipline";
import { disciplinaryWarningFlex, notifyToStaffGroup } from "@/lib/line";

// POST /api/admin/persona/discipline — issue a disciplinary warning
// to a staff member. Inserts the row, generates a ref_no (D + YYYYMM
// + 2-digit seq), and fires a LINE Flex card to the recipient via
// the cross-branch staff group (so the executive group also sees
// disciplinary actions for transparency).

const Body = z.object({
  user_id: z.number().int().positive(),
  severity: z.enum(["verbal", "written_1", "written_2", "final"]),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  reason_category: z.string().trim().max(60).nullable().optional(),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  // Months the warning stays "active" for escalation purposes. Capped
  // at 60 months (5 years) — anything longer is effectively permanent,
  // admin can leave it null in that case for clarity. Null = legacy
  // no-expiry behaviour.
  validity_months: z.number().int().min(1).max(60).nullable().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!userHasBranch(user, user.activeBranchId)) return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const db = getDb();
  // Recipient must belong to the admin's active branch — same scoping
  // as every other PERSONA mutation. Without this an admin who knows
  // a sibling-branch user_id could issue them a warning.
  const inBranch = db.prepare(
    "SELECT 1 AS ok FROM user_branches WHERE user_id = ? AND branch_id = ?"
  ).get(d.user_id, user.activeBranchId) as { ok: 1 } | undefined;
  if (!inBranch) return NextResponse.json({ error: "user_not_in_branch" }, { status: 400 });

  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

  const refNo = generateWarningRef();
  const ins = db.prepare(`
    INSERT INTO disciplinary_warnings
      (branch_id, user_id, issued_by_user_id, severity, title, body,
       reason_category, effective_date, ref_no, validity_months)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    branch.id, d.user_id, user.id, d.severity,
    d.title.trim(), d.body.trim(),
    d.reason_category?.trim() || null,
    d.effective_date || null,
    refNo,
    d.validity_months ?? null
  );
  const id = Number(ins.lastInsertRowid);
  logPersonaAction(user.id, "discipline.issue", id);

  // Fire the LINE notification. Route to the global staff group so
  // both the recipient AND the executive group see the issuance —
  // builds the social pressure / transparency the owner asked for.
  const recipient = db.prepare("SELECT display_name FROM users WHERE id = ?")
    .get(d.user_id) as { display_name: string } | undefined;
  const baseUrl = (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const staffUrl = `${baseUrl || ""}/staff/persona/discipline/${id}`;
  const flex = disciplinaryWarningFlex({
    branchName: branch.name,
    recipientName: recipient?.display_name ?? "—",
    severity: d.severity,
    title: d.title.trim(),
    refNo,
    staffUrl,
    headerColor: branch.brand_color
  });
  notifyToStaffGroup(branch, flex, "global").catch((e) =>
    console.error("discipline notify error", e)
  );

  return NextResponse.json({ ok: true, id, ref_no: refNo });
}
