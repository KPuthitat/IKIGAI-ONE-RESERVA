import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createShiftRequest } from "@/lib/shift-requests";
import { rosterFullOnDate, occupiedPositionIdsOnDate } from "@/lib/roster";

// POST /api/persona/shift-request — staff submit a shift-change request:
//   kind 'extra_shift' → work_date + ตำแหน่ง (position_id) + เวลา (shift_code_id)
//                        so the admin just approves (owner 2026-07-31)
//   kind 'swap'        → work_date + off_date (ขอสลับวันหยุด)
// v1: record + notify the manager; an admin reflects it in the roster.
const Body = z.object({
  kind: z.enum(["extra_shift", "swap"]),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  off_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().max(500).optional(),
  position_id: z.number().int().positive().optional(),
  shift_code_id: z.number().int().positive().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;
  if (d.kind === "swap" && !d.off_date) {
    return NextResponse.json({ error: "off_date_required" }, { status: 400 });
  }

  // ขอเพิ่มกะ: block when the branch's roster for that day is already
  // full — every active position is taken, so there's nowhere to add the
  // person (owner 2026-06-20: คนทำงานเยอะไปแล้ว). 'swap' is exempt: the
  // staff is trading their own day off, not adding net headcount.
  if (d.kind === "extra_shift" && rosterFullOnDate(user.activeBranchId, d.work_date)) {
    return NextResponse.json(
      { error: "roster_full", message: "ตารางวันนั้นเต็มแล้ว ทุกตำแหน่งมีคนลงครบ — ขอเพิ่มกะไม่ได้" },
      { status: 409 }
    );
  }

  // Extra shift now carries the staff-chosen ตำแหน่ง + เวลา so the admin just
  // approves (owner 2026-07-31). Validate both belong to the active branch and
  // that the position is still free on the day.
  if (d.kind === "extra_shift") {
    if (!d.position_id || !d.shift_code_id) {
      return NextResponse.json({ error: "slot_required", message: "เลือกตำแหน่งและเวลาก่อนส่งคำขอ" }, { status: 400 });
    }
    const db = getDb();
    const pos = db.prepare("SELECT id FROM roster_positions WHERE id = ? AND branch_id = ? AND active = 1")
      .get(d.position_id, user.activeBranchId);
    const sc = db.prepare("SELECT id FROM shift_codes WHERE id = ? AND branch_id = ? AND active = 1 AND kind = 'work'")
      .get(d.shift_code_id, user.activeBranchId);
    if (!pos || !sc) {
      return NextResponse.json({ error: "invalid_slot", message: "ตำแหน่งหรือเวลาไม่ถูกต้อง" }, { status: 400 });
    }
    if (occupiedPositionIdsOnDate(user.activeBranchId, d.work_date).includes(d.position_id)) {
      return NextResponse.json({ error: "slot_taken", message: "ตำแหน่งนี้มีคนลงแล้วในวันนั้น เลือกตำแหน่งอื่น" }, { status: 409 });
    }
  }

  const res = createShiftRequest(
    { id: user.id, activeBranchId: user.activeBranchId },
    {
      kind: d.kind, work_date: d.work_date, off_date: d.off_date ?? null, note: d.note?.trim() || null,
      position_id: d.position_id ?? null, shift_code_id: d.shift_code_id ?? null
    }
  );
  return NextResponse.json({ ok: true, ...res });
}
