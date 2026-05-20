"use client";

// Time picker that sits inline as a 1-row button when idle and pops a
// wheel picker open when the customer taps it. Saves vertical space
// on the booking form (the wheel only exists when needed) and reads
// as a "modern" picker — closed state matches the other input rows
// above and below it, expanded state is an iOS-style scroll wheel
// floating on top of the form.
//
//   closed:   [ 18:30                     ▾ ]
//   open:     [ 18:30                     ▴ ]
//             ┌─────────────────────────────┐
//             │      HH       │      MM     │
//             │      17       │      15     │
//             │ ─ ── 18 ── ── │ ── 30 ── ── │   ← centre band
//             │      19       │      45     │
//             └─────────────────────────────┘
//
// Wheels use CSS scroll-snap; a 140ms scroll-end debounce commits
// the resting value. Tap a row to smooth-scroll to it; tap outside
// the popover to close. Break-minute pruning carries over: the MM
// column rebuilds when HH changes so the user never sees a break
// minute, and whole-hours that are 100% break never appear at all.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const ITEM_PX = 40;
const VISIBLE = 5;
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

  const minutes = useMemo(
    () => options.filter((t) => t.slice(0, 2) === selectedHour).map((t) => t.slice(3, 5)),
    [options, selectedHour]
  );

  const onPickHour = useCallback((h: string) => {
    if (disabled) return;
    const sameHourSlots = options.filter((t) => t.slice(0, 2) === h);
    if (sameHourSlots.length === 0) return;
    const keep = sameHourSlots.find((t) => t.slice(3, 5) === selectedMin);
    onChange(keep ?? sameHourSlots[0]);
  }, [disabled, options, selectedMin, onChange]);

  const onPickMin = useCallback((m: string) => {
    if (disabled || !selectedHour) return;
    onChange(`${selectedHour}:${m}`);
  }, [disabled, selectedHour, onChange]);

  // Popover open/close + outside-click handling.
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
    };
  }, [open]);

  if (options.length === 0) {
    return <div className="text-sm text-slate-400 italic py-2">—</div>;
  }

  const displayValue = value.length === 5 ? value : "—";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-expanded={open}
        className="input w-full flex items-center justify-between text-left disabled:opacity-50"
      >
        <span className="text-base font-medium text-slate-800 tabular-nums">
          {displayValue}
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <div
          className="absolute z-30 top-full left-0 right-0 mt-1 rounded-xl border border-slate-200 bg-white shadow-lg overflow-hidden"
          role="dialog"
          aria-label={`${hourLabel} / ${minuteLabel}`}
        >
          <div className="flex divide-x divide-slate-200 relative">
            {/* Centre selection band — pointer-events-none so scroll/
                click events pass through to the wheels underneath. */}
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
        </div>
      )}
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
    <div className="flex-1 min-w-0 relative">
      {/* Top + bottom fade overlays. z-[2] so they sit above the
          centre band but below clicks. */}
      <div
        className="absolute inset-x-0 top-0 pointer-events-none z-[2] bg-gradient-to-b from-white via-white/70 to-transparent"
        style={{ height: CENTRE_TOP }}
      />
      <div
        className="absolute inset-x-0 bottom-0 pointer-events-none z-[2] bg-gradient-to-t from-white via-white/70 to-transparent"
        style={{ height: CENTRE_TOP }}
      />
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
                  ? "text-xl font-bold text-brand"
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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
      aria-hidden
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
