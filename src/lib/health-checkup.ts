// Employee health check-up (ผลตรวจสุขภาพพนักงาน) — modelled on the
// Thai food-handler medical certificate "แบบ ส.ณ.11" (ผู้สัมผัสอาหาร).
//
// NOTE: the exact item wording on ส.ณ.11 varies slightly by local
// health office (เทศบาล/อบต.). The list below is the common food-
// sanitation set used to certify a food handler. It is a *reference*
// checklist — the admin records a result per item, so the wording can
// be fine-tuned later without a schema change (items live in JSON).

export type HealthItemResult = "pass" | "fail" | "na";
//   pass = ปกติ / ไม่เป็น (fit)
//   fail = ผิดปกติ / พบโรค (not fit for this item)
//   na   = ไม่ได้ตรวจ / ไม่ระบุ

export type HealthOverall = "pass" | "fail" | "conditional";

export type HealthCheckItem = {
  key: string;
  label: string;
  /** group heading for the form UI */
  group: "prohibited" | "lab";
};

// Group A — โรคต้องห้ามสำหรับผู้สัมผัสอาหาร (แพทย์รับรองว่า "ไม่เป็น")
// per food-sanitation regulations referenced by ส.ณ.11.
// Group B — การตรวจทางห้องปฏิบัติการ/เพิ่มเติมที่มักแนบมากับใบรับรอง.
export const SN11_ITEMS: HealthCheckItem[] = [
  { key: "tuberculosis", label: "วัณโรคในระยะแพร่กระจายเชื้อ", group: "prohibited" },
  { key: "leprosy", label: "โรคเรื้อน (ระยะติดต่อ/ปรากฏอาการ)", group: "prohibited" },
  { key: "drug_addiction", label: "โรคติดยาเสพติดให้โทษอย่างร้ายแรง", group: "prohibited" },
  { key: "chronic_alcoholism", label: "โรคพิษสุราเรื้อรัง", group: "prohibited" },
  { key: "elephantiasis", label: "โรคเท้าช้างในระยะปรากฏอาการเป็นที่รังเกียจ", group: "prohibited" },
  { key: "skin_disease", label: "โรคผิวหนังที่น่ารังเกียจ", group: "prohibited" },
  { key: "chest_xray", label: "เอกซเรย์ปอด", group: "lab" },
  { key: "stool_exam", label: "ตรวจอุจจาระ / เพาะเชื้อ (ไทฟอยด์ อหิวาต์ บิด)", group: "lab" },
  { key: "hepatitis_a", label: "ไวรัสตับอักเสบชนิดเอ", group: "lab" },
  { key: "general_physical", label: "ตรวจร่างกายทั่วไป", group: "lab" }
];

export type HealthCheckupItemRow = {
  key: string;
  label: string;
  result: HealthItemResult;
};

/** Build the default item rows (all "na") for a new check-up form. */
export function defaultCheckupItems(): HealthCheckupItemRow[] {
  return SN11_ITEMS.map((it) => ({
    key: it.key,
    label: it.label,
    result: "na" as HealthItemResult
  }));
}

export type CheckupStatus = "none" | "valid" | "expiring" | "expired";

/** Days-before-expiry that flips a valid cert into the "expiring" warn
 *  state. Food-handler certs are typically renewed yearly; 30 days
 *  gives admin time to schedule the re-exam. */
export const EXPIRING_WINDOW_DAYS = 30;

/** Derive the at-a-glance status from the latest check-up's expiry. A
 *  record with no expiry_date is treated as valid (some clinics issue
 *  open-ended certs) but the UI still shows the checkup date so admin
 *  can judge staleness. */
export function checkupStatus(
  expiryDate: string | null | undefined,
  today: Date = new Date()
): Exclude<CheckupStatus, "none"> {
  if (!expiryDate) return "valid";
  const exp = new Date(expiryDate + "T00:00:00Z").getTime();
  const now = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate()
  );
  if (exp < now) return "expired";
  const days = (exp - now) / 86_400_000;
  return days <= EXPIRING_WINDOW_DAYS ? "expiring" : "valid";
}

export function overallLabel(o: HealthOverall): string {
  return o === "pass" ? "ผ่าน" : o === "fail" ? "ไม่ผ่าน" : "ผ่านแบบมีเงื่อนไข";
}

export function statusLabel(s: CheckupStatus): string {
  return s === "none" ? "ยังไม่มีผลตรวจ"
    : s === "valid" ? "ใช้ได้"
    : s === "expiring" ? "ใกล้หมดอายุ"
    : "หมดอายุ";
}
