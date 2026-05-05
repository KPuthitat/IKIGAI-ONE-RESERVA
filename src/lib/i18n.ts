// IKIGAI OS — i18n dictionary + helpers
// Default: TH · Cookie: `lang` = "th" | "en"
// Server components: import { getLang, t } from "@/lib/i18n-server"
// Client components: const { t, lang } = useLang()

export type Lang = "th" | "en";

export const SUPPORTED_LANGS: Lang[] = ["th", "en"];
export const DEFAULT_LANG: Lang = "th";

// === DICTIONARY ===
// Convention: namespace.key. ใช้ {var} สำหรับ interpolation
// Example: t("greet", { name: "Test" }) — "greet": "Hello, {name}"

export const dict: Record<Lang, Record<string, string>> = {
  th: {
    // Common
    "common.loading": "กำลังโหลด...",
    "common.error": "เกิดข้อผิดพลาด",
    "common.confirm": "ยืนยัน",
    "common.cancel": "ยกเลิก",
    "common.back": "ย้อนกลับ",
    "common.save": "บันทึก",
    "common.saving": "กำลังบันทึก...",
    "common.delete": "ลบ",
    "common.edit": "แก้ไข",
    "common.add": "เพิ่ม",
    "common.optional": "ไม่บังคับ",
    "common.required": "*",
    "common.yes": "ใช่",
    "common.no": "ไม่",
    "common.close": "ปิด",
    "common.search": "ค้นหา",
    "common.view": "ดู",
    "common.download": "ดาวน์โหลด",
    "common.next": "ถัดไป",
    "common.prev": "ก่อนหน้า",
    "common.actions": "การดำเนินการ",
    "common.status": "สถานะ",
    "common.date": "วันที่",
    "common.time": "เวลา",
    "common.notes": "หมายเหตุ",
    "common.name": "ชื่อ",
    "common.phone": "เบอร์โทรศัพท์",
    "common.dataNotAvailable": "ยังไม่มีข้อมูล",

    // Brand / Layout
    "brand.tagline": "ระบบจัดการธุรกิจ",
    "nav.logout": "ออกจากระบบ",
    "role.admin": "ผู้ดูแลระบบ",
    "role.staff": "พนักงาน",
    "role.adminShort": "ผู้ดูแล",
    "role.staffShort": "พนักงาน",

    // Login
    "login.title": "เข้าระบบ",
    "login.username": "ชื่อผู้ใช้",
    "login.password": "รหัสผ่าน",
    "login.submit": "เข้าระบบ",
    "login.submitting": "กำลังเข้าระบบ...",
    "login.forRole": "สำหรับ{role}",
    "login.error.invalid": "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง",
    "login.error.forbidden": "บัญชีนี้ไม่มีสิทธิ์เข้าฝั่งผู้ดูแล",
    "login.error.missing": "ข้อมูลไม่ครบ",
    "login.error.generic": "เข้าระบบไม่สำเร็จ",

    // Admin / Staff portal
    "portal.chooseModule": "เลือก module",
    "portal.adminSubtitle": "หลังบ้านสำหรับผู้ดูแลระบบ",
    "portal.staffSubtitle": "{name} · พนักงาน",
    "portal.notForbidden": "ไม่มีสิทธิ์เข้าฝั่งผู้ดูแล — ใช้ฝั่งพนักงานแทน",
    "portal.label.module": "MODULE",
    "portal.persona.title": "PERSONA",
    "portal.persona.adminDesc": "ระบบบริหารงานบุคคล · พนักงาน เงินเดือน เวลาเข้าออก",
    "portal.persona.staffDesc": "ลงเวลาเข้า/ออกงาน · ดูประวัติของตัวเอง",
    "portal.reserva.title": "RESERVA",
    "portal.reserva.adminDesc": "ระบบจองโต๊ะ · floor plan, การจอง, สถิติ",
    "portal.reserva.staffDesc": "ดูการจองของลูกค้า · กดสถานะมาแล้ว/ไม่มา",
    "portal.openBackend": "เข้าหลังบ้าน →",
    "portal.openModule": "เปิด →",

    // Customer reserva landing
    "customer.reserva.title": "RESERVA",
    "customer.reserva.subtitle": "จองโต๊ะร้านอาหาร",
    "customer.reserva.featured": "FEATURED",
    "customer.reserva.openHours": "เปิดบริการ {open} – {close} น.",
    "customer.reserva.bookCta": "จองโต๊ะ →",
    "customer.reserva.chooseAnotherBranch": "← เลือกสาขาอื่น",
    "customer.reserva.formIntro": "เปิดบริการ {open} – {close} น. · ระบบจะเลือกโต๊ะที่เหมาะสมที่สุดให้",

    // Booking form
    "booking.field.name": "ชื่อ-นามสกุล",
    "booking.field.phone": "เบอร์โทรศัพท์",
    "booking.field.phonePlaceholder": "08X-XXX-XXXX",
    "booking.field.date": "วันที่",
    "booking.field.time": "เวลา",
    "booking.field.timeUnit": "{time} น.",
    "booking.field.partySize": "จำนวนที่นั่ง",
    "booking.field.notes": "หมายเหตุ (ถ้ามี)",
    "booking.field.notesPlaceholder": "เช่น ขอโต๊ะริมหน้าต่าง, มีเด็ก ฯลฯ",
    "booking.helpUs.title": "ช่วยตอบเพิ่มเติม",
    "booking.helpUs.subtitle": "3 คำถามสั้นๆ เพื่อพัฒนาบริการ (ไม่บังคับ)",
    "booking.field.origin": "เดินทางมาจาก",
    "booking.field.source": "รู้จักร้านจาก (เลือกได้หลายข้อ)",
    "booking.field.member": "เคยเป็นสมาชิกร้านมั้ย",
    "booking.member.yes": "เคยแล้ว",
    "booking.member.no": "ยังไม่เคย",
    "booking.member.hint": "ทีมงานจะแนะนำสมัครสมาชิกฟรีให้ตอนถึงร้าน",
    "booking.origin.sriracha": "ศรีราชา",
    "booking.origin.chonburi": "ชลบุรี (อื่นๆ)",
    "booking.origin.other_province": "ต่างจังหวัด",
    "booking.source.Instagram": "Instagram",
    "booking.source.Facebook": "Facebook",
    "booking.source.TikTok": "TikTok",
    "booking.source.GoogleMaps": "Google",
    "booking.source.friend": "เพื่อนแนะนำ",
    "booking.source.passing": "ผ่านมาเห็น",
    "booking.source.other": "อื่นๆ",
    "booking.cta.findTable": "ค้นหาโต๊ะว่าง",
    "booking.cta.searching": "กำลังค้นหาโต๊ะว่าง...",
    "booking.error.missingNamePhone": "กรุณากรอกชื่อและเบอร์โทรศัพท์",
    "booking.error.noTable": "ขออภัย ช่วงเวลานี้ไม่มีโต๊ะว่างสำหรับ {n} ที่นั่ง กรุณาเลือกเวลาอื่น",
    "booking.choose.title": "เลือกโต๊ะที่ต้องการ",
    "booking.choose.subtitle": "ระบบเลือกโต๊ะที่ขนาดใกล้เคียงกับจำนวนคนของคุณที่สุด",
    "booking.choose.auto": "ให้ระบบเลือกให้อัตโนมัติ (แนะนำ)",
    "booking.choose.tableX": "โต๊ะ {label}",
    "booking.choose.seats": "{n} ที่นั่ง",
    "booking.choose.round": "(โต๊ะกลม)",
    "booking.cta.confirm": "ยืนยันการจอง",
    "booking.cta.confirming": "กำลังบันทึก...",
    "booking.success.title": "จองโต๊ะสำเร็จ!",
    "booking.success.bookingId": "หมายเลขการจอง #{id}",
    "booking.success.summary": "{name} · {n} ที่นั่ง",
    "booking.success.dateTime": "วันที่ {date} เวลา {time}",
    "booking.success.lineNotice": "ทางร้านจะส่งแจ้งเตือนผ่าน LINE ก่อนถึงเวลานัด · กรุณา add LINE Official Account ของร้านเพื่อรับการแจ้งเตือน",
    "booking.success.memberCta.title": "🎟️ สมัครสมาชิกฟรี",
    "booking.success.memberCta.body": "สะสมแต้ม รับสิทธิพิเศษ และส่วนลดทุกครั้งที่มา ทักทีมงานในร้านได้เลย",
    "booking.success.backToBranch": "เลือกสาขาอื่น"
  },
  en: {
    // Common
    "common.loading": "Loading...",
    "common.error": "An error occurred",
    "common.confirm": "Confirm",
    "common.cancel": "Cancel",
    "common.back": "Back",
    "common.save": "Save",
    "common.saving": "Saving...",
    "common.delete": "Delete",
    "common.edit": "Edit",
    "common.add": "Add",
    "common.optional": "optional",
    "common.required": "*",
    "common.yes": "Yes",
    "common.no": "No",
    "common.close": "Close",
    "common.search": "Search",
    "common.view": "View",
    "common.download": "Download",
    "common.next": "Next",
    "common.prev": "Previous",
    "common.actions": "Actions",
    "common.status": "Status",
    "common.date": "Date",
    "common.time": "Time",
    "common.notes": "Notes",
    "common.name": "Name",
    "common.phone": "Phone",
    "common.dataNotAvailable": "No data yet",

    // Brand / Layout
    "brand.tagline": "Business Management Platform",
    "nav.logout": "Sign out",
    "role.admin": "Administrator",
    "role.staff": "Staff",
    "role.adminShort": "Admin",
    "role.staffShort": "Staff",

    // Login
    "login.title": "Sign In",
    "login.username": "Username",
    "login.password": "Password",
    "login.submit": "Sign in",
    "login.submitting": "Signing in...",
    "login.forRole": "for {role}",
    "login.error.invalid": "Invalid username or password",
    "login.error.forbidden": "This account does not have administrator access",
    "login.error.missing": "Missing fields",
    "login.error.generic": "Sign-in failed",

    // Admin / Staff portal
    "portal.chooseModule": "Choose a module",
    "portal.adminSubtitle": "Backend for administrators",
    "portal.staffSubtitle": "{name} · Staff",
    "portal.notForbidden": "No admin access — using staff side instead",
    "portal.label.module": "MODULE",
    "portal.persona.title": "PERSONA",
    "portal.persona.adminDesc": "HR system · employees, payroll, time-clock",
    "portal.persona.staffDesc": "Clock in/out · view your history",
    "portal.reserva.title": "RESERVA",
    "portal.reserva.adminDesc": "Table booking · floor plan, bookings, analytics",
    "portal.reserva.staffDesc": "View customer bookings · mark arrived/no-show",
    "portal.openBackend": "Open backend →",
    "portal.openModule": "Open →",

    // Customer reserva landing
    "customer.reserva.title": "RESERVA",
    "customer.reserva.subtitle": "Book a table",
    "customer.reserva.featured": "FEATURED",
    "customer.reserva.openHours": "Open {open} – {close}",
    "customer.reserva.bookCta": "Book a table →",
    "customer.reserva.chooseAnotherBranch": "← Choose another branch",
    "customer.reserva.formIntro": "Open {open} – {close} · We'll pick the best table for you",

    // Booking form
    "booking.field.name": "Full name",
    "booking.field.phone": "Phone number",
    "booking.field.phonePlaceholder": "08X-XXX-XXXX",
    "booking.field.date": "Date",
    "booking.field.time": "Time",
    "booking.field.timeUnit": "{time}",
    "booking.field.partySize": "Party size",
    "booking.field.notes": "Notes (optional)",
    "booking.field.notesPlaceholder": "e.g., window seat, with kids, etc.",
    "booking.helpUs.title": "Help us improve",
    "booking.helpUs.subtitle": "3 quick questions to help us serve better (optional)",
    "booking.field.origin": "Travelling from",
    "booking.field.source": "How did you hear about us (multi-select)",
    "booking.field.member": "Are you a member?",
    "booking.member.yes": "Yes",
    "booking.member.no": "Not yet",
    "booking.member.hint": "Our team will recommend a free membership when you arrive",
    "booking.origin.sriracha": "Sriracha",
    "booking.origin.chonburi": "Chonburi (other)",
    "booking.origin.other_province": "Other province",
    "booking.source.Instagram": "Instagram",
    "booking.source.Facebook": "Facebook",
    "booking.source.TikTok": "TikTok",
    "booking.source.GoogleMaps": "Google",
    "booking.source.friend": "Recommended by friend",
    "booking.source.passing": "Walked by",
    "booking.source.other": "Other",
    "booking.cta.findTable": "Find available tables",
    "booking.cta.searching": "Searching tables...",
    "booking.error.missingNamePhone": "Please enter your name and phone",
    "booking.error.noTable": "Sorry, no tables available for {n} guests at this time. Please pick another time.",
    "booking.choose.title": "Choose your table",
    "booking.choose.subtitle": "We've selected the closest match to your party size",
    "booking.choose.auto": "Auto-select for me (recommended)",
    "booking.choose.tableX": "Table {label}",
    "booking.choose.seats": "{n} seats",
    "booking.choose.round": "(round)",
    "booking.cta.confirm": "Confirm booking",
    "booking.cta.confirming": "Saving...",
    "booking.success.title": "Booking confirmed!",
    "booking.success.bookingId": "Booking #{id}",
    "booking.success.summary": "{name} · {n} guests",
    "booking.success.dateTime": "{date} at {time}",
    "booking.success.lineNotice": "We'll send a reminder via LINE before your time. Please add our LINE Official Account to receive notifications.",
    "booking.success.memberCta.title": "🎟️ Free membership",
    "booking.success.memberCta.body": "Earn points, get perks, and save on every visit. Ask our team in-store.",
    "booking.success.backToBranch": "Choose another branch"
  }
};

export function t(
  lang: Lang,
  key: string,
  vars?: Record<string, string | number>
): string {
  let str = dict[lang]?.[key] || dict[DEFAULT_LANG][key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

// === Date formatter ===
const TH_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];
const EN_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];
const TH_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Format a YYYY-MM-DD or Date to a localized full date.
 * TH: "5 พฤษภาคม 2569"
 * EN: "May 5, 2026"
 */
export function formatDate(input: string | Date, lang: Lang): string {
  const d = typeof input === "string" ? parseDateString(input) : input;
  if (!d) return String(input);
  const day = d.getDate();
  const month = d.getMonth();
  const year = d.getFullYear();
  if (lang === "th") return `${day} ${TH_MONTHS[month]} ${year + 543}`;
  return `${EN_MONTHS[month]} ${day}, ${year}`;
}

/** Format with weekday: "วันจันทร์ที่ 5 พฤษภาคม 2569" / "Monday, May 5, 2026" */
export function formatDateLong(input: string | Date, lang: Lang): string {
  const d = typeof input === "string" ? parseDateString(input) : input;
  if (!d) return String(input);
  const wd = d.getDay();
  if (lang === "th") return `วัน${TH_WEEKDAYS[wd]}ที่ ${formatDate(d, "th")}`;
  return `${EN_WEEKDAYS[wd]}, ${formatDate(d, "en")}`;
}

function parseDateString(s: string): Date | null {
  // YYYY-MM-DD or ISO
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
