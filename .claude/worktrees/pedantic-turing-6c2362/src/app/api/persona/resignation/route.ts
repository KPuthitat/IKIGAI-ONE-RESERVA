import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { computeMinLastWorkingDay, saveLeaveAttachment, generateRefNo } from "@/lib/leave";

// POST /api/persona/resignation — staff submit
// กฎ: ต้องลาออกล่วงหน้าอย่างน้อย 1 รอบเงินเดือน (= สิ้นเดือนถัดจากเดือนที่ยื่น)
// ถ้าเลือกวันเร็วกว่ากำหนด → ต้องเป็น is_special_request
export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) {
    return NextResponse.json({ error: "expected_multipart" }, { status: 400 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid_form" }, { status: 400 });

  const proposed = String(form.get("proposed_last_day") || "");
  const reason = String(form.get("reason") || "").trim().slice(0, 500);
  const isSpecial = String(form.get("is_special_request") || "") === "1";
  const file = form.get("file");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(proposed)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: "reason_required" }, { status: 400 });
  }

  // ตรวจกติกาขั้นต่ำ
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const minLastDay = computeMinLastWorkingDay(todayBkk);
  if (proposed < todayBkk) {
    return NextResponse.json({ error: "past_date_not_allowed" }, { status: 400 });
  }
  if (proposed < minLastDay && !isSpecial) {
    return NextResponse.json(
      { error: "earlier_than_min_use_special_track", minLastDay },
      { status: 400 }
    );
  }

  // Phase 1C v6 — ต้องได้รับการเปิดสิทธิ์จาก admin ก่อน
  const db = getDb();
  const userRow = db.prepare(
    "SELECT resignation_unlocked_at FROM users WHERE id = ?"
  ).get(user.id) as { resignation_unlocked_at: string | null } | undefined;
  if (!userRow?.resignation_unlocked_at) {
    return NextResponse.json({ error: "must_be_unlocked_by_admin" }, { status: 403 });
  }

  // กันยื่นซ้ำ pending
  const existing = db.prepare(
    "SELECT id FROM resignation_requests WHERE user_id = ? AND status = 'pending'"
  ).get(user.id);
  if (existing) {
    return NextResponse.json({ error: "pending_resignation_exists" }, { status: 409 });
  }

  // Save attachment ถ้ามี
  let evidenceFilename: string | null = null;
  if (file instanceof File && file.size > 0) {
    const saved = await saveLeaveAttachment(user.id, file);
    if (!saved.ok) {
      return NextResponse.json({ error: saved.error }, { status: 400 });
    }
    evidenceFilename = saved.filename;
  }

  const nowIso = new Date().toISOString();
  const refNo = generateRefNo("resignation_requests");
  const tx = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO resignation_requests
        (user_id, proposed_last_day, computed_min_last_day, reason, evidence_filename,
         is_special_request, status, ref_no, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(user.id, proposed, minLastDay, reason, evidenceFilename, isSpecial ? 1 : 0, refNo, nowIso);
    db.prepare(
      "UPDATE users SET resignation_unlocked_at = NULL, resignation_unlocked_by = NULL WHERE id = ?"
    ).run(user.id);
    return r.lastInsertRowid;
  });
  const newId = tx();

  return NextResponse.json({ ok: true, id: newId, ref_no: refNo });
}
