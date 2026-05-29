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

// Each field carries three knobs admin can set:
//   in_red_box  — render in the headline box (boolean)
//   label       — override the wording; null/empty falls back to
//                 the hardcoded Thai default
//   display_order — 1..N, lower renders first
const FieldCfg = z.object({
  in_red_box: z.boolean(),
  label: z.string().trim().max(60).nullable(),
  display_order: z.number().int().min(1).max(99)
});

const Body = z.object({
  closing_drawer: FieldCfg,
  service_charge: FieldCfg,
  daily_revenue:  FieldCfg
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

  // Empty label collapses to NULL so the Flex builder's "label?.trim()
  // || hardcoded" fallback chain produces the original Thai wording.
  const labelOrNull = (s: string | null) =>
    s == null || s.trim() === "" ? null : s.trim();

  getDb().prepare(`
    UPDATE branches
    SET sc_show_drawer_primary  = ?,
        sc_show_svc_primary     = ?,
        sc_show_revenue_primary = ?,
        sc_drawer_label         = ?,
        sc_svc_label            = ?,
        sc_revenue_label        = ?,
        sc_drawer_order         = ?,
        sc_svc_order            = ?,
        sc_revenue_order        = ?
    WHERE id = ?
  `).run(
    parsed.data.closing_drawer.in_red_box ? 1 : 0,
    parsed.data.service_charge.in_red_box ? 1 : 0,
    parsed.data.daily_revenue.in_red_box  ? 1 : 0,
    labelOrNull(parsed.data.closing_drawer.label),
    labelOrNull(parsed.data.service_charge.label),
    labelOrNull(parsed.data.daily_revenue.label),
    parsed.data.closing_drawer.display_order,
    parsed.data.service_charge.display_order,
    parsed.data.daily_revenue.display_order,
    user.activeBranchId
  );

  logPersonaAction(user.id, "shift_close_defaults.update", user.activeBranchId);

  return NextResponse.json({ ok: true });
}
