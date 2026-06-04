// Mounjaro safety-alert rules — pure, server-side, unit-tested.
//
// Computed from the patient's baseline + latest visit + flags. Kept as a
// pure function (no DB) so the clinical dashboard and the test suite share
// exactly the same logic. Rules are the owner's spec (phase 4).

export type AlertLevel = "danger" | "warning";
export type Alert = { level: AlertLevel; code: string; message: string };

export type AlertInput = {
  baselineHr: number | null;
  baselineWeight: number | null;
  lastWeight: number | null;
  currentDose: number | null;
  hr: number | null;
  /** side-effect severities 0–3 from the latest visit */
  abdomen: number;   // ปวดท้อง
  vomit: number;     // อาเจียน
  tachy: number;     // หัวใจเต้นเร็ว
  hypoCount: number;
  adherence: "full" | "missed1" | "missed2" | "held" | null;
  decision: "maintain" | "increase" | "decrease" | "hold" | null;
  /** any of mtc / men2 / preg / allergy ticked */
  hasContraindication: boolean;
  /** patient is on insulin or sulfonylurea */
  onInsulinOrSu: boolean;
  /** weeks the patient has stayed on the current dose */
  weeksAtCurrentDose: number;
  visitCount: number;
};

export function computeAlerts(i: AlertInput): Alert[] {
  const out: Alert[] = [];
  const hrDelta = (i.baselineHr != null && i.hr != null) ? i.hr - i.baselineHr : null;

  // ── DANGER ──────────────────────────────────────────────────────
  if (i.hasContraindication) {
    out.push({ level: "danger", code: "contraindication",
      message: "พบข้อห้ามใช้ยา (MTC / MEN2 / ตั้งครรภ์ / แพ้ยา) — ห้ามใช้ยา" });
  }
  if (hrDelta != null && hrDelta > 15) {
    out.push({ level: "danger", code: "hr_jump",
      message: `ชีพจรเพิ่มขึ้น ${hrDelta} bpm จาก baseline — ส่งตรวจ EKG` });
  }
  if (i.abdomen >= 2) {
    out.push({ level: "danger", code: "abdominal_pain",
      message: "ปวดท้องระดับสูง — เฝ้าระวังตับอ่อนอักเสบ ตรวจ amylase/lipase" });
  }

  // ── WARNING ─────────────────────────────────────────────────────
  if (hrDelta != null && hrDelta >= 10 && hrDelta <= 15) {
    out.push({ level: "warning", code: "hr_rising",
      message: `ชีพจรเพิ่มขึ้น ${hrDelta} bpm จาก baseline — เฝ้าระวัง` });
  }
  if (i.vomit >= 2) {
    out.push({ level: "warning", code: "vomiting",
      message: "อาเจียนระดับสูง — เสี่ยงภาวะขาดน้ำ พิจารณายาแก้อาเจียน" });
  }
  if (i.tachy >= 2) {
    out.push({ level: "warning", code: "tachycardia",
      message: "ใจสั่น/หัวใจเต้นเร็วระดับสูง — ประเมินภาวะหัวใจเต้นผิดจังหวะ ตรวจ EKG" });
  }
  if (i.hypoCount >= 1 && i.onInsulinOrSu) {
    out.push({ level: "warning", code: "hypoglycemia",
      message: "มีภาวะน้ำตาลต่ำขณะใช้ insulin/SU — พิจารณาปรับลดขนาด insulin/SU" });
  }
  if (i.adherence === "missed2" || i.adherence === "held") {
    out.push({ level: "warning", code: "adherence",
      message: "พบการขาดยา/หยุดยา — สอบถามสาเหตุการใช้ยา" });
  }
  if (i.decision === "maintain" && i.currentDose != null && i.currentDose < 15 && i.weeksAtCurrentDose > 8) {
    out.push({ level: "warning", code: "titrate_up",
      message: `คงขนาดเดิมเกิน ${i.weeksAtCurrentDose} สัปดาห์ (ยังไม่ถึง 15 mg) — พิจารณาเพิ่มขนาดยา` });
  }
  if (i.currentDose != null && i.currentDose >= 10 && i.visitCount >= 3
      && i.baselineWeight != null && i.lastWeight != null && i.baselineWeight > 0) {
    const lossPct = ((i.baselineWeight - i.lastWeight) / i.baselineWeight) * 100;
    if (lossPct < 5) {
      out.push({ level: "warning", code: "low_response",
        message: `ลดน้ำหนัก ${lossPct.toFixed(1)}% ต่ำกว่าเป้า (ขนาด ≥10 mg, นัด ≥3 ครั้ง) — ประเมินสาเหตุ` });
    }
  }
  return out;
}

/** Highest severity present, for a row badge. */
export function alertSummary(alerts: Alert[]): AlertLevel | null {
  if (alerts.some((a) => a.level === "danger")) return "danger";
  if (alerts.some((a) => a.level === "warning")) return "warning";
  return null;
}
