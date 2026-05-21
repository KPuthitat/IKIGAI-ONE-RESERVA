"use client";

// Stepper-style time picker: one input row showing the current time
// with ◀ / ▶ buttons on each side that step to the previous / next
// valid 15-minute slot. Lunch-break slots are already absent from
// the `options` list passed in by the parent, so the chevrons skip
// over break windows "for free" — e.g. tapping ▶ at 13:45 jumps
// straight to 17:00 when 14:00–16:45 are inside a break.
//
// Trade-off vs the older wheel: a stepper takes one input row of
// vertical space (great when the customer just wants to nudge the
// default time by a few slots) but is slow if they need to jump
// many hours. For our booking flow most customers tweak by 15-30
// minutes so a stepper is the right default.

import { useMemo } from "react";

export default function TimePicker({
  value,
  onChange,
  options,
  disabled,
  hourLabel: _hourLabel = "Hour",
  minuteLabel: _minuteLabel = "Minute"
}: {
  value: string;
  onChange: (next: string) => void;
  options: string[];
  disabled?: boolean;
  hourLabel?: string;   // kept for backwards-compat with old callers
  minuteLabel?: string; // kept for backwards-compat with old callers
}) {
  const idx = useMemo(() => options.indexOf(value), [options, value]);

  const atStart = idx <= 0;
  const atEnd = idx < 0 || idx >= options.length - 1;
  // Suppress unused-var warnings for the back-compat label props.
  void _hourLabel; void _minuteLabel;

  function step(delta: number): void {
    if (disabled) return;
    if (options.length === 0) return;
    // If the current value isn't in options (rare — fresh page), the
    // first ◀ press should land on the first valid slot, ▶ on the
    // second. Clamping cur to 0 makes -1 → max(0, -1)=0 (first slot).
    const cur = Math.max(0, idx);
    const next = Math.max(0, Math.min(options.length - 1, cur + delta));
    const out = options[next];
    if (out && out !== value) onChange(out);
  }

  if (options.length === 0) {
    return <div className="text-sm text-slate-400 italic py-2">—</div>;
  }

  const display = value && value.length === 5 ? value : "—";

  return (
    <div className="flex items-stretch rounded-lg border border-slate-200 bg-white overflow-hidden w-full">
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={disabled || atStart}
        aria-label="−15"
        className="px-4 py-2.5 text-slate-500 hover:text-brand hover:bg-rose-50/50 active:bg-rose-100/50 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500 transition border-r border-slate-200"
      >
        <ChevronLeft />
      </button>
      <div className="flex-1 text-center text-lg font-bold text-slate-800 tabular-nums flex items-center justify-center select-none">
        {display}
      </div>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={disabled || atEnd}
        aria-label="+15"
        className="px-4 py-2.5 text-slate-500 hover:text-brand hover:bg-rose-50/50 active:bg-rose-100/50 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500 transition border-l border-slate-200"
      >
        <ChevronRight />
      </button>
    </div>
  );
}

function ChevronLeft() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
function ChevronRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
