"use client";

import { useState } from "react";

const OTHER = "__other__";

/**
 * A pick-list that also lets the recorder type their own wording (owner 2026-11-25: "Positive / Negative … or weakly positive").
 * Picking "อื่นๆ (พิมพ์เอง)" — or opening a result whose text is not in the list — shows a text box. Whatever is typed is stored as is;
 * a result that is not one of the item's normal choices is shown as abnormal.
 */
export default function ChoiceField({ value, choices, disabled, onChange, onKeyDown, label }: {
  value: string; choices: string[]; disabled?: boolean; onChange: (v: string) => void; onKeyDown?: (e: React.KeyboardEvent) => void; label?: string;
}) {
  const [forced, setForced] = useState(false);
  const custom = (value !== "" && !choices.includes(value)) || forced;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select data-entry disabled={disabled} className="input min-h-[44px] w-40" aria-label={label} value={custom ? OTHER : value} onKeyDown={onKeyDown}
        onChange={(e) => { if (e.target.value === OTHER) { setForced(true); if (choices.includes(value)) onChange(""); } else { setForced(false); onChange(e.target.value); } }}>
        <option value="">—</option>
        {choices.map((c) => <option key={c} value={c}>{c}</option>)}
        <option value={OTHER}>อื่นๆ (พิมพ์เอง)</option>
      </select>
      {custom && <input data-entry disabled={disabled} className="input min-h-[44px] w-48" maxLength={200} placeholder="พิมพ์ผล เช่น Weakly positive" aria-label={label ? `${label} (พิมพ์เอง)` : "พิมพ์ผลเอง"} value={value} onKeyDown={onKeyDown} onChange={(e) => onChange(e.target.value)} autoFocus={forced && value === ""} />}
    </div>
  );
}
