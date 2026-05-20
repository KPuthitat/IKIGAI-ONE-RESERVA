"use client";

// Minimal wheel time picker — two scrollable columns (HH | MM) inside
// one rounded box so the whole control reads as a single input row
// the same height as the other form fields above it. CSS scroll-snap
// pins each item; a 140ms scroll-end debounce commits the landed
// value and nudges scrollTop back onto the slot if the browser
// missed the snap by a pixel.
//
// Centre row is the selected value: bigger / bolder / brand-coloured.
// Surrounding rows are dimmer so the eye locks onto the centre.
//
// Invalid minutes (lunch break) are pruned PER hour: the MM column
// rebuilds when HH changes so the user never sees a break minute.
// Whole-hours that are 100% break never appear in the HH column.

import { useCallback, useEffect, useMemo, useRef } from "react";

const ITEM_PX = 36;
const VISIBLE = 3;                               // 1 above + centre + 1 below
const PAD_ITEMS = (VISIBLE - 1) / 2;
const CENTRE_TOP = PAD_ITEMS * ITEM_PX;
const COLUMN_HEIGHT = VISIBLE * ITEM_PX;

export default function TimePicker({
  value,
  onChange,
  options,
  disabled,
  hourLabel = "Hour",
  minuteLabel = "Minute"
}: {
  value: string;
  onChange: (next: string) => void;
  options: string[];
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

  // Minutes that are still valid for the currently picked hour
  // (break windows trim this per-hour).
  const minutes = useMemo(
    () => options.filter((t) => t.slice(0, 2) === selectedHour).map((t) => t.slice(3, 5)),
    [options, selectedHour]
  );

  const onPickHour = useCallback((h: string) => {
    if (disabled) return;
    const sameHourSlots = options.filter((t) => t.slice(0, 2) === h);
    if (sameHourSlots.length === 0) return;
    // Prefer keeping the current minute when valid for the new hour.
    const keep = sameHourSlots.find((t) => t.slice(3, 5) === selectedMin);
    onChange(keep ?? sameHourSlots[0]);
  }, [disabled, options, selectedMin, onChange]);

  const onPickMin = useCallback((m: string) => {
    if (disabled || !selectedHour) return;
    onChange(`${selectedHour}:${m}`);
  }, [disabled, selectedHour, onChange]);

  if (options.length === 0) {
    return <div className="text-sm text-slate-400 italic py-2">—</div>;
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden flex divide-x divide-slate-200 relative">
      {/* Centre selection band spans both columns so the highlight
          reads as one row across HH | MM. pointer-events-none keeps
          gestures flowing through. */}
      <div
        className="absolute inset-x-0 border-y border-brand/30 bg-brand/5 pointer-events-none z-[1]"
        style={{ top: CENTRE_TOP, height: ITEM_PX }}
      />
      <Wheel
        items={hours}
        value={selectedHour}
        ariaLabel={hourLabel}
        onPick={onPickHour}
        disabled={disabled}
      />
      <Wheel
        items={minutes}
        value={selectedMin}
        ariaLabel={minuteLabel}
        onPick={onPickMin}
        disabled={disabled}
      />
    </div>
  );
}

function Wheel({
  items, value, ariaLabel, onPick, disabled
}: {
  items: string[];
  value: string;
  ariaLabel: string;
  onPick: (v: string) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<number | undefined>(undefined);
  const lastCommittedRef = useRef<string>(value);

  // Align the wheel to `value` whenever it changes from outside.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const idx = items.indexOf(value);
    if (idx < 0) return;
    lastCommittedRef.current = value;
    el.scrollTop = idx * ITEM_PX;
  }, [items, value]);

  function onScroll(): void {
    const el = ref.current;
    if (!el) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const el2 = ref.current;
      if (!el2) return;
      const raw = el2.scrollTop / ITEM_PX;
      const idx = Math.max(0, Math.min(items.length - 1, Math.round(raw)));
      const next = items[idx];
      if (!next) return;
      const target = idx * ITEM_PX;
      if (Math.abs(el2.scrollTop - target) > 0.5) {
        el2.scrollTo({ top: target, behavior: "smooth" });
      }
      if (next !== lastCommittedRef.current) {
        lastCommittedRef.current = next;
        onPick(next);
      }
    }, 140);
  }

  return (
    <div className="flex-1 min-w-0">
      <div
        ref={ref}
        onScroll={onScroll}
        className="overflow-y-scroll snap-y snap-mandatory no-scrollbar touch-pan-y"
        style={{
          height: COLUMN_HEIGHT,
          scrollbarWidth: "none",
          msOverflowStyle: "none"
        }}
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
      >
        <div style={{ height: CENTRE_TOP }} aria-hidden />
        {items.map((it) => {
          const sel = it === value;
          return (
            <button
              type="button"
              key={it}
              onClick={() => {
                if (disabled) return;
                const el = ref.current;
                if (!el) return;
                const idx = items.indexOf(it);
                if (idx >= 0) el.scrollTo({ top: idx * ITEM_PX, behavior: "smooth" });
              }}
              className={`snap-center w-full flex items-center justify-center leading-none tabular-nums transition-colors ${
                sel
                  ? "text-base font-bold text-brand"
                  : "text-sm text-slate-400"
              }`}
              style={{ height: ITEM_PX }}
              tabIndex={-1}
            >
              {it}
            </button>
          );
        })}
        <div style={{ height: CENTRE_TOP }} aria-hidden />
      </div>
    </div>
  );
}
