import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, OCCASION_KINDS } from "@/lib/db";
import { assignRedemptionForNewRow } from "@/lib/redemption";

// POST /api/staff/walk-in
//
// Staff records a walk-in customer who didn't go through the online
// booking form. Mirrors the booking POST shape but writes to the
// walk_in_visits table so we can report bookings vs walk-ins
// separately while still treating them the same for first-time
// promo + ASCENDA scoring.
//
// Returns the new row's verification_code + redemption_status so the
// staff UI can immediately show "เคลมไอติม" or "ลูกค้าเก่า" without
// a refresh.
//
// Auth: any staff/admin logged into a branch (super_admin works too).

const Body = z.object({
  // guest_name + phone are both optional but at least one must be
  // present to be useful — enforced by superRefine.
  guest_name: z.string().trim().max(80).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  party_size: z.number().int().min(1).max(50),
  table_id: z.number().int().positive().nullable().optional(),
  occasion: z.enum(OCCASION_KINDS).optional(),
  notes: z.string().max(500).optional().nullable()
}).superRefine((v, ctx) => {
  const hasName = v.guest_name && v.guest_name.trim().length > 0;
  const hasPhone = v.phone && v.phone.trim().length > 0;
  if (!hasName && !hasPhone) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "ต้องระบุชื่อหรือเบอร์อย่างน้อย 1 อย่าง",
      path: ["guest_name"]
    });
  }
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  // First-time decision happens BEFORE insert so the snapshot is
  // accurate (otherwise self-matches the row we just wrote).
  const { status: redemptionStatus, code: verificationCode } =
    assignRedemptionForNewRow({ phone: data.phone });

  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO walk_in_visits (
      branch_id, visited_at, guest_name, phone, party_size,
      table_id, occasion, notes,
      first_time, verification_code, redemption_status,
      recorded_by_user_id, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    user.activeBranchId,
    now,
    data.guest_name?.trim() || null,
    data.phone?.trim() || null,
    data.party_size,
    data.table_id ?? null,
    data.occasion ?? null,
    data.notes?.trim() || null,
    redemptionStatus === "eligible" ? 1 : 0,
    verificationCode,
    redemptionStatus,
    user.id,
    now
  );
  const id = result.lastInsertRowid as number;

  // ASCENDA credit for capturing the walk-in (regardless of first-
  // time status — the staff still did the data-entry work). The
  // first-time-redemption credit is added separately when the
  // customer actually claims the ice cream.
  db.prepare(`
    INSERT INTO staff_credits
      (user_id, branch_id, kind, points, ref_table, ref_id, created_at)
    VALUES (?, ?, 'walk_in_capture', 1, 'walk_in_visits', ?, ?)
  `).run(user.id, user.activeBranchId, id, now);

  return NextResponse.json({
    ok: true,
    id,
    verification_code: verificationCode,
    redemption_status: redemptionStatus,
    first_time: redemptionStatus === "eligible"
  });
}
