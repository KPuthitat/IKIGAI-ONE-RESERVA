import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { getDb } from "@/lib/db";
import { getLineGroupId, getCardColor, SALESA_DEFAULT_CARD_COLOR } from "@/lib/salesa-db";
import { memberReport } from "@/lib/insigna";
import { memberReportFlex, sendMemberReport, memberPushTargets, sendMemberMessages, getMemberMessageConfig } from "@/lib/member-line";

// POST /api/admin/insigna/members/notify — PIN-gated sends (owner 2026-10-03):
//   report   → the member report to the ACTIVE branch's HOD LINE group
//   birthday → greeting to consenting members born this month (once a year)
//   winback  → "we miss you" to consenting members gone quiet (30-day guard)

export const dynamic = "force-dynamic";
const Body = z.object({
  kind: z.enum(["report", "birthday", "winback"]),
  year: z.number().int().optional(),
  branch: z.number().int().nullable().optional(),
  pin: z.string()
});

export async function POST(req: Request) {
  const user = requireAdmin();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const gate = verifyAdminPin(user.id, parsed.data.pin);
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.reason === "no_pin" ? 400 : 403 });

  const todayIso = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const year = parsed.data.year ?? Number(todayIso.slice(0, 4));
  const report = memberReport({ year, todayIso, branchId: parsed.data.branch ?? null });

  if (parsed.data.kind === "report") {
    const branchId = user.activeBranchId ?? null;
    if (branchId == null) return NextResponse.json({ error: "no_branch", message: "กรุณาเลือกสาขาก่อน" }, { status: 400 });
    const groupId = getLineGroupId(branchId);
    if (!groupId) return NextResponse.json({ error: "no_group", message: "ยังไม่ได้ตั้งกลุ่ม LINE หัวหน้างานของสาขานี้ (ตั้งที่หน้าตั้งค่า ANALYTICA)" }, { status: 400 });
    const branchName = (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined)?.name ?? `สาขา #${branchId}`;
    const flex = memberReportFlex(report, { branchName, operator: user.display_name, color: getCardColor(branchId) ?? SALESA_DEFAULT_CARD_COLOR });
    const r = await sendMemberReport(groupId, flex);
    if (!r.ok) return NextResponse.json({ error: "push_failed", message: r.error ?? "ส่งไม่สำเร็จ" }, { status: 502 });
    return NextResponse.json({ ok: true, kind: "report" });
  }

  const kind = parsed.data.kind;
  const cfg = getMemberMessageConfig();
  const targets = memberPushTargets(report, kind, todayIso);
  const r = await sendMemberMessages({ kind, targets, text: kind === "birthday" ? cfg.birthday_text : cfg.winback_text, sentBy: user.id });
  return NextResponse.json({ ok: true, kind, targets: targets.length, ...r });
}
