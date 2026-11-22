import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { execGroups, seedGoalTargets, sendWeeklyDigest, setState } from "@/lib/corporate-goal";

// Corporate goal monitor — owner only (C-level figures).
//   POST {action: seed_targets {overwrite} | set_weekly {enabled} | send_now {monday}}
export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(["seed_targets", "set_weekly", "send_now"]),
  overwrite: z.boolean().optional(), enabled: z.boolean().optional(), monday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = p.data;
  if (d.action === "seed_targets") {
    const r = seedGoalTargets(d.overwrite === true);
    logPersonaAction(user.id, "corporate_goal.seed_targets", 0);
    return NextResponse.json({ ok: true, result: r });
  }
  if (d.action === "set_weekly") {
    setState("weekly_enabled", d.enabled ? "1" : "0");
    logPersonaAction(user.id, d.enabled ? "corporate_goal.weekly_on" : "corporate_goal.weekly_off", 0);
    return NextResponse.json({ ok: true, enabled: !!d.enabled, groups: execGroups().length });
  }
  if (!d.monday) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const r = await sendWeeklyDigest(d.monday);
  if (r.groups === 0) return NextResponse.json({ ok: false, error: "no_group", message: "ยังไม่มีกลุ่มผู้บริหารที่เปิดใช้นกฮูก (พิมพ์ “@นกฮูก เปิดใช้กลุ่มนี้” ในกลุ่มก่อน)" }, { status: 409 });
  if (r.sent === 0) return NextResponse.json({ ok: false, error: "push_failed", message: "ส่งเข้ากลุ่ม LINE ไม่สำเร็จ" }, { status: 502 });
  logPersonaAction(user.id, "corporate_goal.send_now", 0);
  return NextResponse.json({ ok: true, sent: r.sent, groups: r.groups, noTargets: r.noTargets });
}
