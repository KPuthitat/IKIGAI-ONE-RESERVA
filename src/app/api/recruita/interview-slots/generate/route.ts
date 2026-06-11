import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { generateInterviewSlots } from "@/lib/recruita-interview-slots";

// POST /api/recruita/interview-slots/generate  (admin)
//   Body: { from_date, to_date, weekdays: number[], start_time, end_time, location? }
//
// Generates open 1-hour interview slots for every selected weekday in
// the date range. Idempotent — re-running over an overlapping range
// only adds the missing slots, never duplicates or clobbers booked ones.

const Body = z.object({
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1),
  start_time: z.string().regex(/^\d{2}:\d{2}$/),
  end_time: z.string().regex(/^\d{2}:\d{2}$/),
  location: z.string().max(300).optional(),
  // Minutes per slot (owner 2026-06-11). Default 60 for older clients.
  slot_minutes: z.number().int().min(5).max(480).optional()
});

const ERR_MSG: Record<string, string> = {
  bad_date: "รูปแบบวันที่ไม่ถูกต้อง",
  range_reversed: "วันเริ่มต้องไม่เกินวันสิ้นสุด",
  no_weekdays: "เลือกวันในสัปดาห์อย่างน้อย 1 วัน",
  bad_time: "รูปแบบเวลาไม่ถูกต้อง",
  bad_duration: "ความยาวช่วงเวลาไม่ถูกต้อง (5–480 นาที)",
  window_too_short: "ช่วงเวลาต้องกว้างพอสำหรับอย่างน้อย 1 ช่วงตามที่ตั้งไว้",
  duration_locked: "มีผู้จองสัมภาษณ์แล้ว — ปรับความยาวช่วงเวลาไม่ได้ (ต้องคงความยาวเดิม)"
};

export async function POST(req: Request) {
  requireAdmin();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" },
      { status: 400 }
    );
  }
  const r = generateInterviewSlots({
    fromDate: parsed.data.from_date,
    toDate: parsed.data.to_date,
    weekdays: parsed.data.weekdays,
    startTime: parsed.data.start_time,
    endTime: parsed.data.end_time,
    location: parsed.data.location ?? null,
    slotMinutes: parsed.data.slot_minutes
  });
  if (!r.ok) {
    return NextResponse.json(
      { ok: false, error: r.error, message: ERR_MSG[r.error] ?? "สร้างช่วงเวลาไม่สำเร็จ" },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true, created: r.created, skipped: r.skipped });
}
