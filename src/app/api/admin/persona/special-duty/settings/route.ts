import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { canManage } from "@/lib/special-duty-access";
import { disableMonth, enableMonth, getMonth, listConfig, listPositions, savePosition, setConfig, SpecialDutyError, WORK_GROUPS } from "@/lib/special-duty";
import { bookingAudience } from "@/lib/special-duty-roster";
import { bookingOpenFlex, pushIndividually } from "@/lib/special-duty-notify";
import { viewerOf } from "@/lib/special-duty-viewer";

// Owner / manager settings for ตำแหน่งงานค่าตอบแทนพิเศษ.
//   GET  ?branch=<id>&month=YYYY-MM → config (owner only), branches the caller may manage, the month and its positions
//   POST {action: set_config | enable_month | disable_month | save_position, ...}

const YM = z.string().regex(/^\d{4}-\d{2}$/);

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const v = viewerOf(user);
  const db = getDb();
  const all = db.prepare("SELECT id, name FROM branches WHERE status != 'closed' ORDER BY display_order, name").all() as Array<{ id: number; name: string }>;
  const branches = all.filter((b) => canManage(v, b.id));
  if (branches.length === 0) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const q = new URL(req.url).searchParams;
  const month = YM.safeParse(q.get("month"));
  // The branch is the one the admin is working in (the switcher in the header); an explicit ?branch= still wins.
  const branchId = branches.find((b) => b.id === Number(q.get("branch")))?.id ?? branches.find((b) => b.id === user.activeBranchId)?.id ?? branches[0].id;
  if (!month.success) return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  return NextResponse.json({
    isOwner: user.role === "super_admin",
    config: user.role === "super_admin" ? listConfig() : null,
    branches, branchId,
    month: getMonth(branchId, month.data),
    positions: listPositions(branchId, month.data),
    workGroups: WORK_GROUPS
  });
}

const Body = z.object({
  action: z.enum(["set_config", "enable_month", "disable_month", "save_position"]),
  key: z.string().optional(), value: z.number().optional(),
  branch_id: z.number().int().optional(), month: YM.optional(),
  slot_no: z.number().int().min(1).max(3).optional(), name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).nullable().optional(), daily_rate: z.number().min(0).max(100000).optional(),
  eligible_groups: z.array(z.string()).nullable().optional(), active: z.boolean().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = p.data;
  const v = viewerOf(user);
  try {
    if (d.action === "set_config") {
      if (user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
      if (!d.key || d.value == null) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
      setConfig(d.key, d.value, user.id);
      logPersonaAction(user.id, "special_duty.config", 0);
      return NextResponse.json({ ok: true, config: listConfig() });
    }
    if (!d.branch_id || !d.month || !canManage(v, d.branch_id)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (d.action === "enable_month") {
      const m = enableMonth({ branchId: d.branch_id, yearMonth: d.month, actorId: user.id });
      // Enabled after the roster was already published → booking opens at once, so invite people now.
      if (m.status === "booking_open") {
        const base = (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");
        const name = (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(d.branch_id) as { name: string }).name;
        const aud = bookingAudience(d.branch_id, d.month);
        pushIndividually(aud.map((a) => a.lineUserId), bookingOpenFlex({ branchName: name, yearMonth: d.month, closeDate: m.bookingCloseDate, url: `${base}/staff/persona/special-duty?month=${d.month}` }))
          .catch((e) => console.error("special duty invite", e));
      }
      logPersonaAction(user.id, "special_duty.enable", d.branch_id);
      return NextResponse.json({ ok: true, month: m });
    }
    if (d.action === "disable_month") {
      const m = disableMonth({ branchId: d.branch_id, yearMonth: d.month, actorId: user.id });
      logPersonaAction(user.id, "special_duty.disable", d.branch_id);
      return NextResponse.json({ ok: true, month: m });
    }
    if (!d.slot_no || !d.name) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    const groups = d.eligible_groups == null ? null : d.eligible_groups.filter((g): g is (typeof WORK_GROUPS)[number] => (WORK_GROUPS as readonly string[]).includes(g));
    const pos = savePosition({ branchId: d.branch_id, yearMonth: d.month, slotNo: d.slot_no, name: d.name, description: d.description ?? null,
      dailyRate: d.daily_rate, eligibleGroups: groups && groups.length ? groups : null, active: d.active, actorId: user.id });
    logPersonaAction(user.id, "special_duty.position", d.branch_id);
    return NextResponse.json({ ok: true, position: pos });
  } catch (e) {
    if (e instanceof SpecialDutyError) return NextResponse.json({ ok: false, error: e.code, detail: e.message }, { status: 409 });
    throw e;
  }
}
