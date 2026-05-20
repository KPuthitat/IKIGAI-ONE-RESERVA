"use client";

// Custom HH + MM picker for the customer booking flow. Two rows of
// chip buttons (one per hour, one per :00/:15/:30/:45) rendered in
// the app's own style — no native browser time control, no plain
// <select> dropdown. The caller hands us the precomputed list of
// valid "HH:MM" strings (which already excludes lunch break + past
// times); we slice that into hour and minute columns and disable any
// minute that isn't valid for the currently-picked hour.

import { useMemo } from "react";

const ALL_MIN = ["00", "15", "30", "45"];

export default function TimePicker({
  value,
  onChange,
  options,
  disabled,
  hourLabel = "Hour",
  minuteLabel = "Minute"
}: {
  value: string;                 // "HH:MM"
  onChange: (next: string) => void;
  options: string[];             // valid "HH:MM" entries
  disabled?: boolean;
  hourLabel?: string;
  minuteLabel?: string;
}) {
  const hours = useMemo(
    () => Array.from(new Set(options.map((t) => t.slice(0, 2)))).sort(),
    [options]
  );

  const selectedHour = value.length === 5 ? value.slice(0, 2) : "";
  const selectedMin  = value.length === 5 ? value.slice(3, 5) : "";

  const minutesForHour = useMemo(
    () => new Set(
      options.filter((t) => t.slice(0, 2) === selectedHour).map((t) => t.slice(3, 5))
    ),
    [options, selectedHour]
  );

  function pickHour(h: string): void {
    if (disabled) return;
    const sameHourSlots = options.filter((t) => t.slice(0, 2) === h);
    if (sameHourSlots.length === 0) return;
    // Try to preserve current minute when it's still valid in the
    // new hour; otherwise default to that hour's first available
    // minute (e.g. switching INTO a partly-break hour).
    const keep = sameHourSlots.find((t) => t.slice(3, 5) === selectedMin);
    onChange(keep ?? sameHourSlots[0]);
  }

  function pickMin(m: string): void {
    if (disabled || !selectedHour) return;
    if (!minutesForHour.has(m)) return;
    onChange(`${selectedHour}:${m}`);
  }

  if (options.length === 0) {
    return <div className="text-sm text-slate-400 italic">—</div>;
  }

  return (
    <div className="space-y-2.5">
      <div>
        <div className="text-[11px] font-bold text-slate-500 mb-1.5 tracking-wider uppercase">
          {hourLabel}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {hours.map((h) => {
            const sel = h === selectedHour;
            return (
              <button
                key={h}
                type="button"
                onClick={() => pickHour(h)}
                disabled={disabled}
                aria-pressed={sel}
                className={`min-w-[44px] px-3 py-1.5 rounded-lg text-sm font-bold border transition ${
                  sel
                    ? "bg-brand text-white border-brand shadow-sm"
                    : "bg-white text-slate-700 border-slate-200 hover:border-brand/60 hover:bg-rose-50/40"
                } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                {h}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <div className="text-[11px] font-bold text-slate-500 mb-1.5 tracking-wider uppercase">
          {minuteLabel}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {ALL_MIN.map((m) => {
            const enabled = minutesForHour.has(m) && !!selectedHour;
            const sel = m === selectedMin;
            return (
              <button
                key={m}
                type="button"
                onClick={() => pickMin(m)}
                disabled={!enabled || disabled}
                aria-pressed={sel}
                className={`min-w-[52px] px-3 py-1.5 rounded-lg text-sm font-bold border transition ${
                  !enabled
                    ? "bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed"
                    : sel
                      ? "bg-brand text-white border-brand shadow-sm"
                      : "bg-white text-slate-700 border-slate-200 hover:border-brand/60 hover:bg-rose-50/40"
                }`}
              >
                {m}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
