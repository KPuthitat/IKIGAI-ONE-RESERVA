"use client";

import type { ReactNode } from "react";

export type PickerStaff = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  fee_exempt?: boolean;
  isCLevel: boolean;
  isAdmin: boolean;
  branchId: number;
  department: string | null;
};
export type PickerBranch = { id: number; name: string };

const NO_DEPT = "ไม่ระบุแผนก";
// Group a branch's staff by แผนก. Departments A→Z, "ไม่ระบุแผนก" last; people keep their incoming order.
function groupByDept(list: PickerStaff[]): Array<{ dept: string; people: PickerStaff[] }> {
  const map = new Map<string, PickerStaff[]>();
  for (const s of list) {
    const d = s.department?.trim() || NO_DEPT;
    (map.get(d) ?? map.set(d, []).get(d)!).push(s);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] === NO_DEPT ? 1 : b[0] === NO_DEPT ? -1 : a[0].localeCompare(b[0], "th")))
    .map(([dept, people]) => ({ dept, people }));
}

// A quick-pick chip. Filled when its whole group is already selected.
function ChipBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`text-[11px] rounded-full border px-2.5 py-1 transition-colors ${
        active
          ? "bg-brand text-white border-brand"
          : "bg-white text-slate-600 border-[color:var(--card-border)] hover:border-brand hover:text-brand"
      }`}>
      {children}
    </button>
  );
}

/** Recipient picker: quick chips, one column per branch, department sub-groups, per-person checkboxes. */
export default function StaffPicker({ label, staff, branches, value, onChange, disabled }: {
  label: string; staff: PickerStaff[]; branches: PickerBranch[]; value: Set<number>; onChange: (next: Set<number>) => void; disabled?: boolean;
}) {
  const allIds = staff.map((s) => s.id);
  const cLevelIds = staff.filter((s) => s.isCLevel).map((s) => s.id);
  const adminIds = staff.filter((s) => s.isAdmin).map((s) => s.id);
  const groupAllIn = (ids: number[]) => ids.length > 0 && ids.every((id) => value.has(id));

  function toggleGroup(ids: number[]) {
    if (disabled) return;
    const next = new Set(value);
    if (ids.length > 0 && ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    onChange(next);
  }
  function toggleOne(id: number) {
    if (disabled) return;
    const next = new Set(value);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  }

  return (
    <div className={disabled ? "opacity-70" : ""}>
      <div className="label"><span>{label} ({value.size})</span></div>
      {staff.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          <span className="text-[11px] text-slate-400 mr-0.5">เลือกด่วน:</span>
          {cLevelIds.length > 0 && <ChipBtn active={groupAllIn(cLevelIds)} onClick={() => toggleGroup(cLevelIds)}>C-level ({cLevelIds.length})</ChipBtn>}
          {adminIds.length > 0 && <ChipBtn active={groupAllIn(adminIds)} onClick={() => toggleGroup(adminIds)}>เฉพาะแอดมิน ({adminIds.length})</ChipBtn>}
          <ChipBtn active={groupAllIn(allIds)} onClick={() => toggleGroup(allIds)}>ทุกคน ({allIds.length})</ChipBtn>
        </div>
      )}
      {staff.length === 0 ? (
        <div className="text-xs text-slate-400">ไม่มีพนักงานในสาขานี้</div>
      ) : (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
          {branches.filter((b) => staff.some((s) => s.branchId === b.id)).map((b) => {
            const list = staff.filter((s) => s.branchId === b.id);
            const allIn = list.every((s) => value.has(s.id));
            return (
              <div key={b.id} className="rounded-lg border border-[color:var(--card-border)] bg-white/60 p-2">
                <div className="flex items-center justify-between px-1 pb-1.5 mb-1 border-b border-[color:var(--card-border)]">
                  <span className="text-sm font-semibold text-brand">{b.name}</span>
                  <button type="button" className="text-[11px] text-slate-500 hover:text-brand" disabled={disabled}
                    onClick={() => toggleGroup(list.map((s) => s.id))}>
                    {allIn ? "ล้างสาขานี้" : "เลือกสาขานี้"}
                  </button>
                </div>
                <div className="space-y-2">
                  {groupByDept(list).map(({ dept, people }) => {
                    const allDept = people.every((s) => value.has(s.id));
                    return (
                      <div key={dept}>
                        <div className="flex items-center justify-between px-1">
                          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{dept}</span>
                          <button type="button" className="text-[10px] text-slate-400 hover:text-brand" disabled={disabled}
                            onClick={() => toggleGroup(people.map((s) => s.id))}>
                            {allDept ? "ล้าง" : "เลือก"}
                          </button>
                        </div>
                        <div className="space-y-0.5">
                          {people.map((s) => (
                            <label key={s.id} className="flex items-center gap-2 text-sm text-slate-700 rounded px-2 py-1 hover:bg-slate-50 cursor-pointer">
                              <input type="checkbox" checked={value.has(s.id)} disabled={disabled} onChange={() => toggleOne(s.id)} />
                              <span>{s.title_prefix ? `${s.title_prefix} ` : ""}{s.display_name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
