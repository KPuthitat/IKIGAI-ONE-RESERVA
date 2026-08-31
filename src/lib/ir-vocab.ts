// IR vocabulary — severity / status / category / incident-type catalogs.
//
// Pure data (no better-sqlite3 import) so BOTH the server data layer (ir-db.ts)
// and client components (the filing form, the review panel) can import it. The
// server re-exports these from ir-db.ts for convenience; the client imports
// here directly. Mirrors the rbac.ts split.

export type IrSeverity = 1 | 2 | 3 | 4 | 5;
export type IrIncidentType = "near_miss" | "actual" | "complaint";
export type IrStatus = "new" | "reviewing" | "action" | "closed" | "dismissed";

export const IR_SEVERITIES: Array<{
  value: IrSeverity; labelTh: string; descTh: string; tone: string; dot: string;
}> = [
  { value: 1, labelTh: "เกือบพลาด", descTh: "เกือบเกิด จับได้ก่อน ยังไม่กระทบใคร (Near Miss)",
    tone: "text-emerald-700 bg-emerald-50 border-emerald-200", dot: "bg-emerald-500" },
  { value: 2, labelTh: "เล็กน้อย", descTh: "เกิดขึ้นจริงแต่ไม่มีผลเสียหาย/ไม่บาดเจ็บ",
    tone: "text-sky-700 bg-sky-50 border-sky-200", dot: "bg-sky-500" },
  { value: 3, labelTh: "ปานกลาง", descTh: "กระทบลูกค้า/พนักงานบ้าง แก้ไขหน้างานได้",
    tone: "text-amber-700 bg-amber-50 border-amber-200", dot: "bg-amber-500" },
  { value: 4, labelTh: "รุนแรง", descTh: "บาดเจ็บ/เสียหาย/เสียชื่อเสียง ต้องตามแก้",
    tone: "text-orange-700 bg-orange-50 border-orange-200", dot: "bg-orange-500" },
  { value: 5, labelTh: "วิกฤต", descTh: "อันตรายถึงชีวิต/เสียหายหนัก/เข้าข่ายกฎหมาย",
    tone: "text-rose-700 bg-rose-50 border-rose-200", dot: "bg-rose-500" }
];

export function severityMeta(v: number) {
  return IR_SEVERITIES.find((s) => s.value === v) ?? IR_SEVERITIES[1];
}

export const IR_INCIDENT_TYPES: Array<{ value: IrIncidentType; labelTh: string }> = [
  { value: "near_miss", labelTh: "เกือบพลาด (Near Miss)" },
  { value: "actual", labelTh: "เกิดขึ้นจริง" },
  { value: "complaint", labelTh: "ข้อร้องเรียน" }
];

export function incidentTypeLabel(v: string): string {
  return IR_INCIDENT_TYPES.find((t) => t.value === v)?.labelTh ?? v;
}

export const IR_STATUSES: Array<{ value: IrStatus; labelTh: string; tone: string }> = [
  { value: "new", labelTh: "ใหม่", tone: "text-slate-700 bg-slate-100 border-slate-200" },
  { value: "reviewing", labelTh: "กำลังทบทวน", tone: "text-sky-700 bg-sky-50 border-sky-200" },
  { value: "action", labelTh: "กำลังแก้ไข", tone: "text-amber-700 bg-amber-50 border-amber-200" },
  { value: "closed", labelTh: "ปิดเคส", tone: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  { value: "dismissed", labelTh: "ไม่นับเป็นเหตุการณ์", tone: "text-slate-400 bg-slate-50 border-slate-200" }
];

export function statusMeta(v: string) {
  return IR_STATUSES.find((s) => s.value === v) ?? IR_STATUSES[0];
}

// A status counts as "open work" (badge / open list) until closed or dismissed.
export const IR_OPEN_STATUSES: IrStatus[] = ["new", "reviewing", "action"];

// category keys grouped for the picker. Grouping is display-only; the stored
// value is the flat "group.key" string.
export const IR_CATEGORY_GROUPS: Array<{
  group: string; items: Array<{ key: string; labelTh: string }>;
}> = [
  {
    group: "คลินิก",
    items: [
      { key: "clinic.patient_safety", labelTh: "ความปลอดภัยผู้รับบริการ" },
      { key: "clinic.medication", labelTh: "ยา/เวชภัณฑ์" },
      { key: "clinic.procedure", labelTh: "เครื่องมือ/หัตถการ" },
      { key: "clinic.infection", labelTh: "การติดเชื้อ/สุขอนามัย" }
    ]
  },
  {
    group: "ร้านอาหาร",
    items: [
      { key: "resto.food_safety", labelTh: "ความปลอดภัยอาหาร" },
      { key: "resto.hygiene", labelTh: "ความสะอาด/สุขาภิบาล" },
      { key: "resto.kitchen_accident", labelTh: "อุบัติเหตุในครัว" },
      { key: "resto.complaint", labelTh: "ร้องเรียนลูกค้า" }
    ]
  },
  {
    group: "ทั่วไป",
    items: [
      { key: "general.facility", labelTh: "สถานที่/อาคาร" },
      { key: "general.asset", labelTh: "ทรัพย์สิน/เงิน" },
      { key: "general.staff", labelTh: "พนักงาน/อาชีวอนามัย" },
      { key: "general.it", labelTh: "ระบบ/ไอที" },
      { key: "general.other", labelTh: "อื่นๆ" }
    ]
  }
];

const CATEGORY_LABEL = new Map<string, string>();
const CATEGORY_GROUP = new Map<string, string>();
for (const g of IR_CATEGORY_GROUPS) {
  for (const it of g.items) {
    CATEGORY_LABEL.set(it.key, it.labelTh);
    CATEGORY_GROUP.set(it.key, g.group);
  }
}
export const IR_CATEGORY_KEYS = [...CATEGORY_LABEL.keys()];
export function categoryLabel(key: string): string {
  return CATEGORY_LABEL.get(key) ?? key;
}
export function categoryGroup(key: string): string {
  return CATEGORY_GROUP.get(key) ?? "อื่นๆ";
}
