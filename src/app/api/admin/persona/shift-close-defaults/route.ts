import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, userCanAdminBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/persona/shift-close-defaults
//
// Set the per-branch toggles that decide which of the three default
// money fields render in the red "headline" box at the top of the
// post-shift Flex card. Body is the new state for each toggle:
//
//   { closing_drawer: boolean, service_charge: boolean, daily_revenue: boolean }
//
// All three default to true (= included in red box). Toggling a
// field off doesn't hide it from the submit form — it just demotes
// it from the headline block to the regular checklist body.
//
// Targets the operator's currently-active branch (admins can only
// edit branches they administer). Mirrors the existing per-branch
// settings flow used by other config endpoints.

const Body = z.object({
  closing_drawer: z.boolean(),
  service_charge: z.boolean(),
  daily_revenue: z.boolean()
});

export async function POST(req: Request) {
  const user = requireAdmin();
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  if (!userCanAdminBranch(user, user.activeBranchId)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  getDb().prepare(`
    UPDATE branches
    SET sc_show_drawer_primary  = ?,
        sc_show_svc_primary     = ?,
        sc_show_revenue_primary = ?
    WHERE id = ?
  `).run(
    parsed.data.closing_drawer ? 1 : 0,
    parsed.data.service_charge ? 1 : 0,
    parsed.data.daily_revenue  ? 1 : 0,
    user.activeBranchId
  );

  logPersonaAction(user.id, "shift_close_defaults.update", user.activeBranchId);

  return NextResponse.json({ ok: true });
}
