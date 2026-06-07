// Exercise catalog + RPE scale for the weight-control program's
// self-recorded activity log (owner #11-16, 2026-06-06).
//
// This is a fixed, owner-supplied reference table. met values are
// metabolic-equivalent estimates used only for an APPROXIMATE energy
// figure ("พลังงานโดยประมาณ") — never a target and never a deficit
// calculation. The catalog is intentionally static and shared by the
// employee self-portal, the doctor view, and the API validator so all
// three agree on level/met for a given activity id.

export type ExerciseLevel = "light" | "medium" | "heavy";

export type ExerciseActivity = {
  id: string;
  level: ExerciseLevel;
  name: string;
  /** Suggested duration (minutes) — prefilled, editable by the user. */
  defaultMin: number;
  /** Metabolic equivalent — for the approximate energy estimate only. */
  met: number;
};

export const EXERCISE_CATALOG: ReadonlyArray<ExerciseActivity> = [
  { id: "EX-L1", level: "light",  name: "เดินสบาย ๆ",                    defaultMin: 20, met: 3.0 },
  { id: "EX-L2", level: "light",  name: "ยืดเหยียด / โยคะเบา",            defaultMin: 15, met: 2.5 },
  { id: "EX-L3", level: "light",  name: "เดินขึ้นลงบันไดช้า ๆ",          defaultMin: 10, met: 3.5 },
  { id: "EX-L4", level: "light",  name: "ปั่นจักรยานอยู่กับที่ (เบา)",    defaultMin: 15, met: 3.5 },
  { id: "EX-L5", level: "light",  name: "งานบ้าน / เดินจับจ่าย",          defaultMin: 20, met: 3.0 },
  { id: "EX-M1", level: "medium", name: "เดินเร็ว",                       defaultMin: 30, met: 4.3 },
  { id: "EX-M2", level: "medium", name: "จ๊อกกิ้งเบา",                    defaultMin: 25, met: 6.0 },
  { id: "EX-M3", level: "medium", name: "ปั่นจักรยานปานกลาง",            defaultMin: 30, met: 5.5 },
  { id: "EX-M4", level: "medium", name: "แอโรบิก / เต้น",                 defaultMin: 25, met: 5.0 },
  { id: "EX-M5", level: "medium", name: "เซอร์กิตบอดี้เวท",              defaultMin: 20, met: 5.0 },
  { id: "EX-M6", level: "medium", name: "ว่ายน้ำเบา–ปานกลาง",           defaultMin: 25, met: 5.8 },
  { id: "EX-H1", level: "heavy",  name: "วิ่ง",                          defaultMin: 35, met: 8.5 },
  { id: "EX-H2", level: "heavy",  name: "HIIT",                          defaultMin: 28, met: 8.0 },
  { id: "EX-H3", level: "heavy",  name: "เวทเทรนนิ่งทั้งตัว",            defaultMin: 45, met: 6.0 },
  { id: "EX-H4", level: "heavy",  name: "ปั่นจักรยานเร็ว / สปินนิ่ง",     defaultMin: 40, met: 9.0 },
  { id: "EX-H5", level: "heavy",  name: "กีฬาแข่ง",                      defaultMin: 50, met: 7.5 },
  { id: "EX-H6", level: "heavy",  name: "ว่ายน้ำต่อเนื่อง",              defaultMin: 35, met: 8.5 }
];

/** Borg CR10 perceived-exertion scale (0–10). Mandatory on every log so
 *  the doctor can spot a mismatch between activity level and effort. */
export const RPE_SCALE: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0,  label: "พัก / ไม่ออกแรงเลย" },
  { value: 1,  label: "เบามาก" },
  { value: 2,  label: "เบา" },
  { value: 3,  label: "เบา–พอประมาณ" },
  { value: 4,  label: "ปานกลาง (พูดเป็นประโยคได้)" },
  { value: 5,  label: "ปานกลาง–ค่อนข้างหนัก" },
  { value: 6,  label: "หนัก" },
  { value: 7,  label: "หนัก (พูดได้สั้น ๆ)" },
  { value: 8,  label: "หนักมาก" },
  { value: 9,  label: "หนักมาก (พูดได้แค่คำเดียว)" },
  { value: 10, label: "หนักสุด ๆ / เต็มที่" }
];

/** Display order + Thai labels for the three intensity levels. */
export const EXERCISE_LEVELS: ReadonlyArray<{ key: ExerciseLevel; label: string }> = [
  { key: "light",  label: "เบา" },
  { key: "medium", label: "ปานกลาง" },
  { key: "heavy",  label: "หนัก" }
];

const BY_ID: Record<string, ExerciseActivity> =
  Object.fromEntries(EXERCISE_CATALOG.map((a) => [a.id, a]));

export function getActivity(id: string): ExerciseActivity | null {
  return BY_ID[id] ?? null;
}

/** Sentinel for a "did not exercise / rest day" log (owner 2026-06-08).
 *  Stored with level 'rest', duration 0, met 0, rpe 0 — excluded from the
 *  weekly exercise stats, but kept so the doctor sees the rest day. */
export const REST_ACTIVITY_ID = "rest";
export const REST_LABEL = "ไม่ได้ออกกำลังกาย (วันพัก)";

/** Display name for a logged row, including the rest sentinel. */
export function activityLabel(id: string): string {
  if (id === REST_ACTIVITY_ID) return REST_LABEL;
  return getActivity(id)?.name ?? id;
}

export function levelLabel(level: string): string {
  return EXERCISE_LEVELS.find((l) => l.key === level)?.label ?? level;
}

export function rpeLabel(value: number): string {
  return RPE_SCALE.find((r) => r.value === value)?.label ?? String(value);
}

/** Approximate energy: kcal ≈ met × weightKg × hours. Returns null when
 *  we don't have a baseline weight (we never invent the figure). */
export function kcalEstimate(
  met: number, weightKg: number | null | undefined, durationMin: number
): number | null {
  if (weightKg == null || !(weightKg > 0)) return null;
  return met * weightKg * (durationMin / 60);
}

/** Soft clinical flag (#15): a "light" activity logged at a high effort
 *  (RPE ≥ 7) may signal low energy / a drug side-effect — surfaced to the
 *  doctor, never blocks the employee from logging. */
export function isLowEnergyFlag(level: string, rpe: number): boolean {
  return level === "light" && rpe >= 7;
}
