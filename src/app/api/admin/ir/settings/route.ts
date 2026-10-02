import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { getIrLineGroupId, setIrLineGroupId, listReports } from "@/lib/ir-db";
import { notifyIrRmGroup } from "@/lib/ir-line";

// IR settings (owner 2026-10-02) — the RM team's LINE group a new report is
// pushed to, per branch. The NOKHOOK OS platform OA must be a member.
//   GET   → { lineGroupId }
//   POST  { lineGroupId }        → save (null/blank = off)
//   POST  { test: true }         → push the branch's latest report as a test card

export const dynamic = "force-dynamic";

function ctx() {
  const user = requirePermission("ir.manage");
  return { user, branchId: user.activeBranchId ?? null };
}

const Body = z.object({
  lineGroupId: z.string().max(200).nullable().optional(),
  test: z.boolean().optional()
}).strict();

export function GET() {
  const { branchId } = ctx();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  return NextResponse.json({ ok: true, lineGroupId: getIrLineGroupId(branchId) });
}

export async function POST(req: Request) {
  const { branchId } = ctx();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  if (parsed.data.lineGroupId !== undefined) setIrLineGroupId(branchId, parsed.data.lineGroupId);
  if (parsed.data.test) {
    const latest = listReports({ branchId, status: "all", limit: 1 })[0];
    if (!latest) return NextResponse.json({ error: "no_report", message: "ยังไม่มีรายงานในสาขานี้ให้ส่งทดสอบ" }, { status: 400 });
    const r = await notifyIrRmGroup(branchId, latest.id);
    if (!r.ok) {
      const message = r.skipped === "no_group" ? "ยังไม่ได้ตั้ง Group ID"
        : r.skipped === "platform_oa_not_configured" ? "ยังไม่ได้ตั้งค่า platform OA ของระบบ"
        : `LINE ปฏิเสธการส่ง (${r.error ?? "unknown"}) — ตรวจว่า OA อยู่ในกลุ่มและ Group ID ถูกต้อง`;
      return NextResponse.json({ error: r.skipped ?? r.error ?? "send_failed", message }, { status: 400 });
    }
    return NextResponse.json({ ok: true, sent: latest.code ?? `#${latest.id}`, lineGroupId: getIrLineGroupId(branchId) });
  }
  return NextResponse.json({ ok: true, lineGroupId: getIrLineGroupId(branchId) });
}
