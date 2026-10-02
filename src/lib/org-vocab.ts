// Organisation vocabulary — client-safe (no DB import), shared by the employee
// form, the org chart and the approval-chain page (owner 2026-10-02).

export type DepartmentKey = "service" | "kitchen" | "management" | "other";

export const DEPARTMENTS: Array<{ key: DepartmentKey; labelTh: string; tone: string }> = [
  { key: "service",    labelTh: "ฝ่ายบริการ", tone: "bg-sky-100 text-sky-800 border-sky-200" },
  { key: "kitchen",    labelTh: "ฝ่ายครัว",   tone: "bg-amber-100 text-amber-800 border-amber-200" },
  { key: "management", labelTh: "ฝ่ายบริหาร", tone: "bg-violet-100 text-violet-800 border-violet-200" },
  { key: "other",      labelTh: "อื่นๆ",      tone: "bg-slate-100 text-slate-700 border-slate-200" }
];
export const DEPARTMENT_KEYS = DEPARTMENTS.map((d) => d.key);
export function departmentLabel(key: string | null | undefined): string | null {
  return DEPARTMENTS.find((d) => d.key === key)?.labelTh ?? null;
}
export function departmentTone(key: string | null | undefined): string {
  return DEPARTMENTS.find((d) => d.key === key)?.tone ?? "bg-slate-100 text-slate-500 border-slate-200";
}

// Where a person sits in the chain of command, derived from the branch
// approval tiers — decides who they may report to.
export type ChainRank = "executive" | "supervisor" | "staff";
export const CHAIN_RANK_LABEL: Record<ChainRank, string> = {
  executive: "ผู้บริหาร (ชั้นที่ 2)",
  supervisor: "หัวหน้างาน (ชั้นที่ 1)",
  staff: "พนักงาน"
};
