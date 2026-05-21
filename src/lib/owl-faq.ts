// Static FAQ data — น้องฮูก's "knowledge base" for the free tier.
//
// Each entry has TH + EN content. Keywords are pre-extracted from
// likely user questions (synonyms, common typos) so the search box
// can do simple substring matching without an embedding model.
//
// When we add the paid AI tier (B/C) the same entries become the
// canonical context — feed them as system prompts so the AI never
// hallucinates a feature that doesn't exist.

export type FaqAudience = "any" | "admin" | "staff";

export type FaqCategory =
  | "start"
  | "clock"
  | "leave"
  | "roster"
  | "discipline"
  | "svc"
  | "line"
  | "settings"
  | "trouble";

export type FaqEntry = {
  id: string;
  category: FaqCategory;
  audience: FaqAudience;
  question_th: string;
  question_en: string;
  answer_th: string;       // supports basic markdown (newlines, **bold**, links via {url:label})
  answer_en: string;
  keywords: string[];      // lowercase substrings the search matches
  link?: { href: string; label_th: string; label_en: string };
};

export const FAQ_CATEGORIES: Array<{ id: FaqCategory; label_th: string; label_en: string; emoji: string }> = [
  // Emoji field kept for backward-compat with existing callers, but
  // intentionally blank — the help UI now relies on plain labels +
  // น้องฮูก's own mascot for visual personality. Less clutter on a
  // long FAQ list, easier to read in Thai.
  { id: "start",      label_th: "เริ่มต้นใช้งาน",  label_en: "Getting started", emoji: "" },
  { id: "clock",      label_th: "ลงเวลาเข้า-ออก", label_en: "Time clock",      emoji: "" },
  { id: "leave",      label_th: "ขอลา",          label_en: "Leave requests",  emoji: "" },
  { id: "roster",     label_th: "ตารางงาน",      label_en: "Duty roster",     emoji: "" },
  { id: "discipline", label_th: "หนังสือเตือน",   label_en: "Disciplinary",    emoji: "" },
  { id: "svc",        label_th: "เซอร์วิสชาร์จ",   label_en: "Service charge",  emoji: "" },
  { id: "line",       label_th: "LINE OA",       label_en: "LINE OA",         emoji: "" },
  { id: "settings",   label_th: "ตั้งค่าระบบ",     label_en: "System settings", emoji: "" },
  { id: "trouble",    label_th: "ปัญหาทั่วไป",     label_en: "Troubleshooting", emoji: "" }
];

export const FAQ_ENTRIES: FaqEntry[] = [
  {
    id: "login-first-time",
    category: "start",
    audience: "any",
    question_th: "เข้าระบบครั้งแรกต้องทำอย่างไร?",
    question_en: "How do I log in for the first time?",
    answer_th:
      "ใช้ username + password ที่หัวหน้างานสร้างให้\n" +
      "1. เข้าหน้า /login\n" +
      "2. กรอก username + password\n" +
      "3. ระบบจะพาไปหน้าเลือก module (PERSONA / RESERVA)\n\n" +
      "ถ้ายังไม่ได้รับ username หรือลืม password ติดต่อหัวหน้างานครับ",
    answer_en:
      "Use the username + password your supervisor set up for you.\n" +
      "1. Go to /login\n" +
      "2. Enter username + password\n" +
      "3. Pick a module (PERSONA / RESERVA) from the picker\n\n" +
      "Contact your supervisor if you haven't been given credentials.",
    keywords: ["login", "เข้าระบบ", "เข้า", "password", "รหัสผ่าน", "username", "ครั้งแรก"]
  },
  {
    id: "set-pin",
    category: "start",
    audience: "staff",
    question_th: "ตั้ง PIN 4 หลักได้ที่ไหน?",
    question_en: "Where do I set my 4-digit PIN?",
    answer_th:
      "PIN ใช้ลงเวลาเข้า-ออก + กดรับทราบหนังสือเตือน\n\n" +
      "ตั้งครั้งแรก: หัวหน้างานจะตั้งให้คุณจากหน้าจัดการพนักงาน\n" +
      "เปลี่ยนเอง: ไปที่ /staff/persona แล้วกดเมนู 'ตั้ง PIN' (ถ้ายังไม่เคยตั้ง ระบบจะถามตอนคลิก 'ลงเวลา' ครั้งแรก)",
    answer_en:
      "Your PIN is used for clock-in/out and to acknowledge disciplinary warnings.\n\n" +
      "First time: your supervisor sets it from the admin staff page.\n" +
      "To change: go to /staff/persona and tap the 'Set PIN' menu. If you've never set one, the system prompts on first clock-in.",
    keywords: ["pin", "รหัสpin", "ตั้งpin", "4 หลัก"],
    link: { href: "/staff/persona", label_th: "ไปหน้าลงเวลา", label_en: "Go to time clock" }
  },
  {
    id: "clock-how",
    category: "clock",
    audience: "staff",
    question_th: "ลงเวลาเข้างาน-ออกงานอย่างไร?",
    question_en: "How do I clock in / out?",
    answer_th:
      "ที่หน้า /staff/persona (เมนูแรกของ PERSONA)\n" +
      "1. กดปุ่ม 'ลงเวลาเข้า' หรือ 'ลงเวลาออก'\n" +
      "2. ถ้าสาขาเปิด GPS — ระบบจะขอ location ของคุณ\n" +
      "3. ถ้าสาขาเปิด QR — สแกน QR code ที่ติดในร้าน\n" +
      "4. ใส่ PIN 4 หลัก\n\n" +
      "ถ้าผิดพลาดภายใน 5 นาที ระบบจะถามว่า 'แทนที่ด้วยเวลาปัจจุบันหรือใช้เวลาเดิม?'\n" +
      "เกิน 5 นาทีต้องส่งคำขอ 'รับรองเวลา' ให้แอดมินอนุมัติแก้",
    answer_en:
      "From /staff/persona (first PERSONA menu):\n" +
      "1. Tap 'Clock In' or 'Clock Out'\n" +
      "2. If your branch enforces GPS, allow location\n" +
      "3. If QR is required, scan the in-shop QR poster\n" +
      "4. Enter your 4-digit PIN\n\n" +
      "Mistakes within 5 minutes can be replaced. Past 5 minutes, file a time-certification request.",
    keywords: ["ลงเวลา", "เข้างาน", "ออกงาน", "clock", "เช็คอิน", "checkin", "gps", "qr"],
    link: { href: "/staff/persona", label_th: "ไปหน้าลงเวลา", label_en: "Go to time clock" }
  },
  {
    id: "clock-fix-late",
    category: "clock",
    audience: "staff",
    question_th: "ลืมลงเวลา / ลงผิด ทำอย่างไร?",
    question_en: "I forgot to clock in — how do I fix it?",
    answer_th:
      "ภายใน 5 นาที: กด 'ลงเวลา' อีกครั้ง ระบบจะถามว่าใช้เวลาเดิมหรือแทนที่\n\n" +
      "เกิน 5 นาที:\n" +
      "1. ไปที่ /staff/persona/time-certification\n" +
      "2. เลือกรายการที่ต้องแก้\n" +
      "3. ใส่เวลาที่ถูกต้อง + เหตุผล\n" +
      "4. รอหัวหน้างานอนุมัติ — ระบบจะแก้ time_entry ให้อัตโนมัติ",
    answer_en:
      "Within 5 minutes: tap clock-in again — the system asks if you want to replace.\n\n" +
      "After 5 minutes: file a time-certification at /staff/persona/time-certification with the correct timestamp and a reason. Admin reviews + applies the fix.",
    keywords: ["ลืมลง", "ลงผิด", "แก้เวลา", "รับรองเวลา", "certification"],
    link: { href: "/staff/persona/time-certification", label_th: "ขอรับรองเวลา", label_en: "Request time cert" }
  },
  {
    id: "leave-file",
    category: "leave",
    audience: "staff",
    question_th: "ขอลาทำอย่างไร?",
    question_en: "How do I file a leave request?",
    answer_th:
      "1. ไปที่ /staff/persona/leave\n" +
      "2. กด '+ ขอลาใหม่'\n" +
      "3. เลือกประเภท (ป่วย / กิจ / พักร้อน / ฯลฯ)\n" +
      "4. เลือกวันที่เริ่ม-สิ้นสุด + เหตุผล\n" +
      "5. แนบหลักฐาน (ถ้ามี เช่น ใบรับรองแพทย์)\n" +
      "6. กดส่งคำขอ — หัวหน้างานจะได้รับแจ้งทาง LINE\n\n" +
      "ระบบจะแจ้งกลับเมื่อหัวหน้าอนุมัติ/ไม่อนุมัติ",
    answer_en:
      "Go to /staff/persona/leave → '+ New leave' → pick type, dates, reason, attach evidence if any. Your supervisor gets a LINE notification.",
    keywords: ["ลา", "ขอลา", "ลาป่วย", "ลากิจ", "ลาพักร้อน", "leave"],
    link: { href: "/staff/persona/leave", label_th: "ขอลา", label_en: "File leave" }
  },
  {
    id: "calendar-view",
    category: "roster",
    audience: "staff",
    question_th: "ดูตารางงานของฉันได้ที่ไหน?",
    question_en: "Where do I see my work schedule?",
    answer_th:
      "ไปที่ /staff/persona/calendar (เมนู 'ปฏิทินของฉัน')\n\n" +
      "หน้านี้แสดงทุกวันในเดือน:\n" +
      "• วันที่หัวหน้าจัดให้ทำงาน → ตำแหน่ง + เวลาเข้า-ออก + คำอธิบายงาน\n" +
      "• วันที่ไม่ได้จัด = วันหยุดประจำสัปดาห์ของคุณวันนั้น\n\n" +
      "ระบบจะแจ้งใน LINE ทุกครั้งที่หัวหน้าเผยแพร่ตารางใหม่หรือมีการแก้ไข",
    answer_en:
      "Go to /staff/persona/calendar. Days you're assigned show position + hours + scope. Empty days = your weekly off. LINE notifies you when the supervisor publishes or edits the roster.",
    keywords: ["ตาราง", "calendar", "ปฏิทิน", "ของฉัน"],
    link: { href: "/staff/persona/calendar", label_th: "เปิดปฏิทินของฉัน", label_en: "Open my calendar" }
  },
  {
    id: "roster-publish",
    category: "roster",
    audience: "admin",
    question_th: "จัดตารางเดือนใหม่อย่างไร?",
    question_en: "How do I publish next month's roster?",
    answer_th:
      "1. ไปที่ /admin/persona/roster\n" +
      "2. ใช้ month picker เลือกเดือนข้างหน้า\n" +
      "3. ก่อนเริ่ม — ตรวจ 'รหัสกะ' (/admin/persona/roster/shifts) และ 'ตำแหน่ง' (/admin/persona/roster/positions) ให้พร้อม\n" +
      "4. คลิกช่องในตาราง → modal ขึ้นมา → เลือกพนักงาน + รหัสกะ\n" +
      "5. เมื่อกรอกครบ กดปุ่ม '📣 เผยแพร่ตารางเดือนนี้'\n" +
      "6. ระบบจะส่ง Flex เข้ากลุ่ม IKIGAI OS แจ้งพนักงานทุกคน\n\n" +
      "แก้ไขหลังเผยแพร่: คลิกช่องเดิม → แก้ → กดปุ่ม '✏️ แจ้งว่ามีการแก้ไข' ส่งแจ้งซ้ำได้",
    answer_en:
      "Go to /admin/persona/roster, pick the month, ensure shift codes and positions are set up, click cells to assign, then hit '📣 Publish'. LINE notifies all staff. Edit later → use '✏️ Announce edit'.",
    keywords: ["จัดตาราง", "roster", "เผยแพร่", "publish", "ตารางมอบหมาย"],
    link: { href: "/admin/persona/roster", label_th: "ไปจัดตาราง", label_en: "Go to roster" }
  },
  {
    id: "discipline-issue",
    category: "discipline",
    audience: "admin",
    question_th: "ออกหนังสือเตือนพนักงานทำอย่างไร?",
    question_en: "How do I issue a disciplinary warning?",
    answer_th:
      "1. ไปที่ /admin/persona/discipline\n" +
      "2. กดปุ่ม '+ ออกหนังสือเตือน'\n" +
      "3. เลือกพนักงาน + ระดับ (วาจา / ลายลักษณ์อักษร ครั้ง 1, 2 / final)\n" +
      "4. กรอกหัวข้อ + เนื้อหา\n" +
      "5. กดส่ง → ระบบส่ง LINE Flex ให้พนักงาน + กลุ่มผู้บริหารทันที\n\n" +
      "พนักงานต้องเปิดอ่านและกด PIN รับทราบ\n" +
      "ถ้าเปิดอ่านแล้วไม่กด ระบบจะรับทราบให้อัตโนมัติเมื่อออกจากหน้า (บันทึกแยกเป็น 'auto')",
    answer_en:
      "Go to /admin/persona/discipline → '+ Issue warning' → pick staff, severity, subject, body → send. LINE notifies them. They must PIN-acknowledge, or the system auto-acknowledges when they leave the page.",
    keywords: ["หนังสือเตือน", "ตักเตือน", "วินัย", "warning", "discipline"],
    link: { href: "/admin/persona/discipline", label_th: "ไปออกหนังสือเตือน", label_en: "Go to discipline" }
  },
  {
    id: "discipline-ack",
    category: "discipline",
    audience: "staff",
    question_th: "ได้รับหนังสือเตือน ทำอย่างไร?",
    question_en: "I received a warning — what now?",
    answer_th:
      "1. คลิกลิงก์ที่ส่งใน LINE หรือไปที่ /staff/persona/discipline\n" +
      "2. กดที่ฉบับที่ยังไม่ได้รับทราบ\n" +
      "3. อ่านเนื้อหาให้เข้าใจ\n" +
      "4. ใส่ PIN 4 หลักของคุณ + กดปุ่ม 'รับทราบ'\n\n" +
      "หมายเหตุ: ถ้าออกจากหน้าก่อนกดรับทราบ ระบบจะถือว่าคุณรับทราบโดยอัตโนมัติและบันทึกไว้ในประวัติ ไม่สามารถอ้างได้ว่า 'ไม่เห็น'",
    answer_en:
      "Open the LINE link or go to /staff/persona/discipline → tap the pending warning → read it → enter PIN + Acknowledge. If you leave the page without acknowledging, the system auto-acknowledges on your behalf.",
    keywords: ["รับทราบ", "หนังสือเตือน", "ack", "ตักเตือน"],
    link: { href: "/staff/persona/discipline", label_th: "เปิดหนังสือเตือนของฉัน", label_en: "Open my warnings" }
  },
  {
    id: "svc-daily-entry",
    category: "svc",
    audience: "any",
    question_th: "บันทึกยอดเซอร์วิสชาร์จรายวันที่ไหน?",
    question_en: "Where do I log daily service-charge totals?",
    answer_th:
      "2 วิธี:\n\n" +
      "A) ผู้ปิดกะกรอกในแบบฟอร์ม shift_close ทุกวัน — ที่ /staff/persona/shift/close มีช่อง 'ยอดเซอร์วิสชาร์จวันนี้'\n\n" +
      "B) แอดมินกรอกย้อนหลังที่ /admin/persona/service-charge — แก้ไขได้ ทุกการแก้จะถูก log ว่าใครแก้เมื่อไหร่\n\n" +
      "ระบบแบ่งให้พนักงาน 60% (หารตามชั่วโมงทำงาน) เข้าบริษัท 40% อัตโนมัติ\n" +
      "ถ้าพนักงานสายเกิน 20% ของเวลาที่มอบหมายในเดือนนั้น = ตัดสิทธิ์ SVC ทั้งเดือน",
    answer_en:
      "Two ways: (A) closing-shift staff fills it on the shift_close form, or (B) admin enters/edits at /admin/persona/service-charge. System splits 60/40 to staff/company; staff late >20% monthly forfeits their share.",
    keywords: ["เซอร์วิสชาร์จ", "svc", "service charge", "ทิป", "tip", "กองกลาง"],
    link: { href: "/admin/persona/service-charge", label_th: "ไปหน้า SVC", label_en: "Go to SVC" }
  },
  {
    id: "branch-settings-gps",
    category: "settings",
    audience: "admin",
    question_th: "ตั้งค่า GPS / QR สำหรับการลงเวลาอย่างไร?",
    question_en: "How do I set up GPS / QR for time clock?",
    answer_th:
      "ไปที่ /admin/persona/settings\n\n" +
      "GPS geofence:\n" +
      "1. เปิดสวิตช์ 'เปิดใช้ GPS'\n" +
      "2. กดปุ่ม '📍 ใช้ตำแหน่งปัจจุบัน' ตอนยืนอยู่หน้าร้าน — ระบบจะ pin lat/lng ให้\n" +
      "3. ตั้งรัศมี (ค่าเริ่มต้น 100m เหมาะกับร้านอาหารทั่วไป)\n\n" +
      "QR code:\n" +
      "1. เปิดสวิตช์ 'เปิดใช้ QR code'\n" +
      "2. กด '🎲 Generate ใหม่' → ระบบสุ่ม token\n" +
      "3. พิมพ์ QR ติดในร้าน (สามารถใช้ tool ภายนอกแปลง token เป็น QR)\n\n" +
      "เปิดทั้ง 2 ได้พร้อมกัน — พนักงานต้องผ่านทั้งคู่",
    answer_en:
      "Go to /admin/persona/settings. GPS: enable + tap '📍 Use current location' while standing in the shop + set radius (100m default). QR: enable + 'Generate' a token + print as a QR poster. Both can be enforced together.",
    keywords: ["gps", "geofence", "qr", "ลงเวลา", "ตั้งค่า", "anti-cheat"],
    link: { href: "/admin/persona/settings", label_th: "ไปตั้งค่าสาขา", label_en: "Branch settings" }
  },
  {
    id: "line-oa-setup",
    category: "line",
    audience: "admin",
    question_th: "ตั้งค่า LINE OA สำหรับแจ้งเตือนอย่างไร?",
    question_en: "How do I set up LINE OA notifications?",
    answer_th:
      "ระบบใช้ LINE OA 2 ระดับ:\n\n" +
      "1. **IKIGAI OS (global)** — แจ้งเตือน PERSONA ทั้งหมด (ตารางงาน, หนังสือเตือน, สรุปการเข้างาน ฯลฯ)\n" +
      "   ตั้งที่: /admin/system-settings\n" +
      "   ต้องการ: Channel Access Token + Group ID ของกลุ่มผู้บริหาร\n\n" +
      "2. **OA ของแต่ละสาขา** — แจ้งเตือนการจอง RESERVA เฉพาะสาขานั้นๆ\n" +
      "   ตั้งที่: /admin/persona/messaging\n" +
      "   ต้องการ: Channel Access Token + Channel Secret\n\n" +
      "หา Token / Group ID ได้ที่ LINE Developers Console (developers.line.biz)",
    answer_en:
      "Two LINE OA layers: (1) IKIGAI OS global for PERSONA — set at /admin/system-settings; (2) per-branch for RESERVA bookings — set at /admin/persona/messaging. Get tokens at developers.line.biz.",
    keywords: ["line", "oa", "messaging", "แจ้งเตือน", "token"],
    link: { href: "/admin/system-settings", label_th: "ตั้งค่าระบบ", label_en: "System settings" }
  },
  {
    id: "roster-shift-codes",
    category: "roster",
    audience: "admin",
    question_th: "สร้างรหัสกะใหม่ทำอย่างไร?",
    question_en: "How do I create a new shift code?",
    answer_th:
      "1. ไปที่ /admin/persona/roster/shifts (หรือกดปุ่ม 'ตั้งค่ารหัสกะ' ในหน้าตาราง)\n" +
      "2. กดปุ่ม '+ เพิ่มกะใหม่'\n" +
      "3. ตั้งสี (สำหรับแสดงในตาราง) + รหัสสั้น (เช่น NPF) + ชื่อ (ไม่บังคับ)\n" +
      "4. ใส่เวลาเข้า-ออก + เวลาพัก (ถ้ามี)\n" +
      "5. กด save\n\n" +
      "ลบกะ = ปิดการใช้งาน (soft-delete) — ตารางในอดีตจะยังอ้างอิงรหัสนี้ได้",
    answer_en:
      "Go to /admin/persona/roster/shifts → '+ Add shift' → pick color, short code, name, start/end times, optional break. Delete = soft-delete so past rosters keep referencing it.",
    keywords: ["รหัสกะ", "shift code", "กะ", "เวลาเข้า"]
  },
  {
    id: "profile-self-edit",
    category: "settings",
    audience: "staff",
    question_th: "แก้ไขข้อมูลส่วนตัวของฉันที่ไหน?",
    question_en: "Where do I edit my personal info?",
    answer_th:
      "ไปที่ /staff/persona/profile (เมนู 'โปรไฟล์ของฉัน')\n\n" +
      "ฟิลด์ที่แก้ได้: ชื่อ-นามสกุล TH/EN, ชื่อเล่น, วันเกิด, สัญชาติ/ศาสนา/สถานภาพ, ที่อยู่ทะเบียนบ้าน + ที่อยู่ติดต่อ, ผู้ติดต่อฉุกเฉิน, ส่วนสูง/น้ำหนัก\n\n" +
      "ฟิลด์ที่แก้ไม่ได้ (หัวหน้าเป็นคนกำหนด): เพศ, อีเมลบริษัท, ตำแหน่งงาน, ผู้บังคับบัญชา, สถานะการจ้างงาน, เงินเดือน, ฯลฯ\n\n" +
      "ถ้าหัวหน้างานปิดการแก้ไขแล้ว ทุก field จะ lock — ต้องแจ้งหัวหน้าให้เปิดให้ก่อน",
    answer_en:
      "Go to /staff/persona/profile. You can edit names, nickname, DOB, religion, addresses, emergency contact, height/weight. Supervisor-controlled fields (gender, employment, salary, supervisor) are read-only. If profile editing is locked, ask your supervisor to reopen it.",
    keywords: ["โปรไฟล์", "ข้อมูลส่วนตัว", "ที่อยู่", "ฉุกเฉิน", "profile"],
    link: { href: "/staff/persona/profile", label_th: "เปิดโปรไฟล์ของฉัน", label_en: "Open my profile" }
  },
  {
    id: "trouble-cant-clock-in",
    category: "trouble",
    audience: "staff",
    question_th: "ลงเวลาเข้าไม่ได้ — ทำอย่างไร?",
    question_en: "I can't clock in — what should I do?",
    answer_th:
      "เช็ค error ที่ระบบขึ้น:\n\n" +
      "• 'GPS required' — เปิด location ใน browser + ลองใหม่ ถ้ายังไม่ได้แจ้งหัวหน้า\n" +
      "• 'Out of geofence' — คุณอยู่นอกพื้นที่ร้าน เดินเข้าใกล้กว่านี้\n" +
      "• 'QR required' — สแกน QR ที่ติดในร้าน\n" +
      "• 'Wrong PIN' — ลอง PIN ใหม่ ถ้าลืมแจ้งหัวหน้าให้รีเซ็ต\n" +
      "• 'Too many attempts' — ระบบล็อก รอ X วินาทีแล้วลองใหม่\n\n" +
      "ถ้าทุกอย่างถูกแล้วแต่ยังไม่ได้ ส่งคำขอรับรองเวลา + แจ้งหัวหน้างานเรื่อง bug ที่เจอ",
    answer_en:
      "Read the error: GPS required → allow location; Out of geofence → walk closer; QR required → scan poster; Wrong PIN → try again or ask for reset; Too many attempts → wait. If nothing works, file a time-cert + tell your supervisor.",
    keywords: ["ลงเวลาไม่ได้", "error", "gps error", "pin ผิด", "trouble"]
  },
  {
    id: "trouble-line-not-received",
    category: "trouble",
    audience: "any",
    question_th: "ไม่ได้รับการแจ้งเตือนทาง LINE",
    question_en: "I'm not getting LINE notifications",
    answer_th:
      "ตรวจสอบเป็นขั้นๆ:\n\n" +
      "1. คุณเป็นเพื่อนกับ IKIGAI OS OA แล้วหรือยัง? (สแกน QR ของ OA เพื่อเพิ่มเพื่อน)\n" +
      "2. line_user_id ของคุณ bind กับ account แล้วหรือยัง? → ดูที่หน้า /staff/persona — ถ้าไม่ได้ bind แจ้งหัวหน้าให้กรอกให้\n" +
      "3. กลุ่ม LINE ของบริษัทมี OA เป็นสมาชิกหรือยัง? (สำหรับ notification กลุ่ม)\n" +
      "4. Admin: ที่ /admin/system-settings ใส่ Channel Token + Group ID ครบหรือยัง?\n\n" +
      "ลองส่งข้อความทดสอบ: หัวหน้าออกหนังสือเตือนทดสอบ → ดูว่ามาหรือไม่",
    answer_en:
      "Check: are you friends with the OA? Is your line_user_id bound to your account? Is the OA in the group? Has admin filled in the global Channel Token + Group ID at /admin/system-settings? Run a test issue and see if it lands.",
    keywords: ["line", "ไม่ได้รับ", "notification", "แจ้งเตือน", "ไม่มา"]
  }
];

// ── Helpers ──────────────────────────────────────────────────────

/** Filter FAQ entries by search query + category + audience. Case-
 *  insensitive substring match on question + keywords + answer.
 *  Returns entries sorted by best match (questions outweigh keywords
 *  outweigh answer body). */
export function searchFaq(
  query: string,
  opts?: { category?: FaqCategory; audience?: FaqAudience; lang?: "th" | "en" }
): FaqEntry[] {
  const lang = opts?.lang ?? "th";
  const q = query.trim().toLowerCase();
  let pool = FAQ_ENTRIES;
  if (opts?.category) pool = pool.filter((e) => e.category === opts.category);
  if (opts?.audience && opts.audience !== "any") {
    pool = pool.filter((e) => e.audience === "any" || e.audience === opts.audience);
  }
  if (!q) return pool;
  const scored = pool.map((e) => {
    const question = (lang === "en" ? e.question_en : e.question_th).toLowerCase();
    const answer = (lang === "en" ? e.answer_en : e.answer_th).toLowerCase();
    let score = 0;
    if (question.includes(q)) score += 10;
    for (const kw of e.keywords) {
      if (kw.toLowerCase().includes(q) || q.includes(kw.toLowerCase())) score += 5;
    }
    if (answer.includes(q)) score += 1;
    return { e, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.e);
}
