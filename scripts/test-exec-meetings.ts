// ประชุมผู้บริหาร + เบี้ยประชุม — join/minutes/end + fee proof (owner 2026-09-02).
//
// Self-contained: builds a throwaway DB, invites a staff member, and proves the
// gating (only invited, active-only, no double join, minutes required to end)
// and the เบี้ยประชุม math (200 บาท/ชม., per-minute; exempt → 0).
//
// Run:  node --import tsx scripts/test-exec-meetings.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-exec-meetings.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const em = await import("../src/lib/exec-meetings");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  // ── pure fee helper ──
  ok("fee: 90 นาที = 300", em.meetingFeeForMinutes(90) === 300);
  ok("fee: 45 นาที = 150", em.meetingFeeForMinutes(45) === 150);
  ok("fee: 100 นาที = 333.33 (รายนาที)", em.meetingFeeForMinutes(100) === 333.33);
  ok("fee: 0 นาที = 0", em.meetingFeeForMinutes(0) === 0);

  const mkUser = (u: string, exempt = 0) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status,meeting_fee_exempt) VALUES (?,'x',?,'staff','active',?)"
  ).run(u, u, exempt).lastInsertRowid);
  const uid = mkUser("staff1");
  const other = mkUser("staff2");
  const execU = mkUser("boss", 1);   // ยกเว้นเบี้ยประชุม

  // ── create + invite ──
  const mid = em.createExecMeeting({ title: "ประชุมทดสอบ", meeting_date: "2026-09-02", branch_id: null, invitee_user_ids: [uid, execU], created_by: uid });
  ok("gating: ยังไม่เปิด → join ไม่ได้", em.joinMeeting(mid, uid) === "meeting_not_active");

  em.updateExecMeeting(mid, { status: "active" });
  ok("gating: คนไม่ได้เชิญ → join ไม่ได้", em.joinMeeting(mid, other) === "not_invited");
  ok("join: ผู้ได้รับเชิญเข้าร่วมได้", em.joinMeeting(mid, uid) === null);
  ok("gating: เข้าร่วมซ้ำไม่ได้", em.joinMeeting(mid, uid) === "already_joined");

  // ── end blocked until minutes complete ──
  const e0 = em.endMeeting(mid, uid);
  ok("gating: จบไม่ได้ถ้ารายงานไม่ครบ", "error" in e0 && e0.error === "minutes_incomplete");
  em.saveMinutes(mid, uid, { locked_answers: [], extra_items: [{ topic: "วาระ", details: "รายละเอียด", suggestions: "ข้อเสนอ", action_plan: "แผน", owner_user_ids: [] }] });

  // backdate join by 90 minutes so the timer yields a real duration
  db.prepare("UPDATE exec_meeting_attendance SET joined_at = datetime('now','-90 minutes') WHERE meeting_id=? AND user_id=?").run(mid, uid);
  const e1 = em.endMeeting(mid, uid);
  ok("end: คิดเวลา 90 นาที", !("error" in e1) && e1.minutes === 90);
  ok("end: เบี้ยประชุม = 300 (200/ชม.)", !("error" in e1) && e1.fee === 300);
  ok("end: จบซ้ำไม่ได้", "error" in em.endMeeting(mid, uid));

  // ── exempt exec: attends but fee = 0 ──
  em.joinMeeting(mid, execU);
  em.saveMinutes(mid, execU, { locked_answers: [], extra_items: [{ topic: "ก", details: "ข", suggestions: "ค", action_plan: "ง", owner_user_ids: [] }] });
  db.prepare("UPDATE exec_meeting_attendance SET joined_at = datetime('now','-60 minutes') WHERE meeting_id=? AND user_id=?").run(mid, execU);
  const e2 = em.endMeeting(mid, execU);
  ok("exempt: คิดเวลา 60 นาที", !("error" in e2) && e2.minutes === 60);
  ok("exempt: เบี้ยประชุม = 0 (ยกเว้น)", !("error" in e2) && e2.fee === 0);

  // ── preset agenda (วาระตั้งล่วงหน้า) + multi-วาระ minutes ──
  const uid3 = mkUser("staff3");
  const mid2 = em.createExecMeeting({
    title: "ประชุมมีวาระ", meeting_date: "2026-09-03", branch_id: null,
    agenda_topics: ["  ยอดขาย  ", "ปัญหาหน้าร้าน", ""],   // blank dropped, others trimmed
    invitee_user_ids: [uid3], created_by: uid3
  });
  em.updateExecMeeting(mid2, { status: "active" });
  const detail = em.getExecMeeting(mid2);
  ok("agenda: เก็บวาระล่วงหน้า (ตัดช่องว่าง/รายการว่าง)",
    !!detail && detail.agenda_topics.length === 2 && detail.agenda_topics[0] === "ยอดขาย" && detail.agenda_topics[1] === "ปัญหาหน้าร้าน");

  const v0 = em.getStaffMeetingView(mid2, uid3);
  ok("agenda: staff เห็นวาระที่ล็อกไว้ 2 อัน", !!v0 && v0.locked_items.length === 2 && v0.extra_items.length === 0);

  em.joinMeeting(mid2, uid3);
  // Answer only the first locked วาระ → still incomplete (must answer all วาระ).
  em.saveMinutes(mid2, uid3, {
    locked_answers: [{ details: "ดี", suggestions: "เพิ่มโปร", action_plan: "ทำ" }, { details: "", suggestions: "", action_plan: "" }],
    extra_items: []
  });
  ok("agenda: ยังไม่ครบถ้าตอบวาระที่ล็อกไม่ครบทุกอัน", em.getStaffMeetingView(mid2, uid3)!.minutes_complete === false);

  // Client can't rename a locked topic — server re-attaches preset topic text.
  em.saveMinutes(mid2, uid3, {
    locked_answers: [
      { details: "ดี", suggestions: "เพิ่มโปร", action_plan: "ทำ" },
      { details: "คิวยาว", suggestions: "เพิ่มคน", action_plan: "จ้าง" }
    ],
    extra_items: [{ topic: "เรื่องอื่น", details: "x", suggestions: "y", action_plan: "z", owner_user_ids: [] }]
  });
  const v1 = em.getStaffMeetingView(mid2, uid3)!;
  ok("agenda: ตอบครบทุกวาระ (ล็อก+เพิ่มเอง) → ครบ", v1.minutes_complete === true);
  ok("agenda: หัวข้อล็อกยังเป็นของผู้จัด", v1.locked_items[0].topic === "ยอดขาย" && v1.locked_items[1].topic === "ปัญหาหน้าร้าน");
  ok("agenda: วาระที่เพิ่มเองแยกไว้", v1.extra_items.length === 1 && v1.extra_items[0].topic === "เรื่องอื่น");
  const detail2 = em.getExecMeeting(mid2)!;
  const inv3 = detail2.invitees.find((i) => i.user_id === uid3)!;
  ok("agenda: แอดมินเห็น 3 วาระของ staff", inv3.items.length === 3 && inv3.minutes_complete === true);

  // ── ผู้รับผิดชอบต่อวาระ — เลือกจากผู้ได้รับเชิญ, กรองคนนอกทิ้ง (owner 2026-09-02) ──
  em.setInvitees(mid2, [uid3, uid]);   // add uid as a second invitee
  em.saveMinutes(mid2, uid3, {
    locked_answers: [
      { details: "ดี", suggestions: "เพิ่มโปร", action_plan: "ทำ", owner_user_ids: [uid, other] }, // other = คนนอก → ถูกกรอง
      { details: "คิวยาว", suggestions: "เพิ่มคน", action_plan: "จ้าง", owner_user_ids: [] }
    ],
    extra_items: []
  });
  const v2 = em.getStaffMeetingView(mid2, uid3)!;
  ok("owner: attendees pool = ผู้ได้รับเชิญ (2 คน)", v2.attendees.length === 2);
  ok("owner: บันทึกผู้รับผิดชอบที่เป็นผู้ได้รับเชิญ", v2.locked_items[0].owner_user_ids.length === 1 && v2.locked_items[0].owner_user_ids[0] === uid);
  ok("owner: กรองคนนอกที่ประชุมทิ้ง", !v2.locked_items[0].owner_user_ids.includes(other));

  // ── AI summary parser: section format survives markdown newlines (owner 2026-09-02) ──
  const ai = await import("../src/lib/exec-meeting-ai");
  const sample = [
    "===SUMMARY===",
    "## ภาพรวม",
    "ประชุมเรื่องยอดขาย มีหลายบรรทัด",
    "- ประเด็น ก",
    "- ประเด็น ข",
    "===CHECKLIST===",
    "- ทำโปรโมชั่น :: สมชาย",
    "- แก้คิวหน้าร้าน :: -",
    "===CARRYOVER===",
    "- เรื่องค้างจากสัปดาห์ก่อน"
  ].join("\n");
  const parsed = ai.parseMeetingAi(sample);
  ok("ai-parse: summary เก็บ markdown หลายบรรทัด", parsed.summary.includes("ภาพรวม") && parsed.summary.includes("ประเด็น ข"));
  ok("ai-parse: checklist แยก item/ผู้รับผิดชอบ", parsed.checklist.length === 2 && parsed.checklist[0].owner === "สมชาย" && parsed.checklist[1].owner === undefined);
  ok("ai-parse: carryover อ่านได้", parsed.carryover.length === 1 && parsed.carryover[0].item.includes("ค้าง"));
  let threw = false;
  try { ai.parseMeetingAi("ขยะที่อ่านไม่ออก"); } catch { threw = true; }
  ok("ai-parse: ข้อความมั่วๆ → โยน error", threw);

  // ── payroll integration: เบี้ยประชุม lands on the line, taxable, once ──
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  const payroll = await import("../src/lib/payroll-compute");
  const bid = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('m','MEET BRANCH')").run().lastInsertRowid);
  // uid ended a 90-min meeting on 2026-09-02 → fee 300. Make them an FT with a
  // primary branch + salary so a monthly round covering that date includes them.
  db.prepare("UPDATE users SET employment_type='ft', monthly_salary=30000, pay_cycle='monthly', salary_tax_mode='sso', hire_date='2026-01-01' WHERE id=?").run(uid);
  db.prepare("INSERT OR IGNORE INTO user_branches (user_id, branch_id, is_primary) VALUES (?, ?, 1)").run(uid, bid);
  const pid = Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status,branch_id,target,data_source) VALUES ('monthly','2026-09-01','2026-09-30','2026-10-05','draft',?,'ft','auto')"
  ).run(bid).lastInsertRowid);
  payroll.computePayrollPeriod(db, pid);
  const line = db.prepare("SELECT base_pay, meeting_fee, gross_pay, sso_amount, net_pay FROM payroll_lines WHERE period_id=? AND user_id=?")
    .get(pid, uid) as { base_pay: number; meeting_fee: number; gross_pay: number; sso_amount: number; net_pay: number } | undefined;
  ok("payroll: มีบรรทัดเงินเดือนของผู้เข้าประชุม", !!line);
  if (line) {
    ok("payroll: เบี้ยประชุม 300 อยู่บนบรรทัด (แยกช่อง)", near(line.meeting_fee, 300));
    ok("payroll: ฐานเงินเดือน 30000 (ไม่ปนเบี้ย)", near(line.base_pay, 30000));
    ok("payroll: ยอดรวม = 30000 + 300 เบี้ยประชุม", near(line.gross_pay, 30300));
    ok("payroll: net รวมเบี้ยประชุม (หักประกันสังคม)", near(line.net_pay, Math.round((30300 - line.sso_amount) * 100) / 100));
  }
  // Recompute must keep it (idempotent, no double-count).
  payroll.computePayrollPeriod(db, pid);
  const line2 = db.prepare("SELECT meeting_fee, gross_pay FROM payroll_lines WHERE period_id=? AND user_id=?")
    .get(pid, uid) as { meeting_fee: number; gross_pay: number };
  ok("payroll: คำนวณใหม่ เบี้ยประชุมไม่ซ้ำซ้อน (ยัง 300)", near(line2.meeting_fee, 300) && near(line2.gross_pay, 30300));

  console.log(`\nexec-meetings test: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
