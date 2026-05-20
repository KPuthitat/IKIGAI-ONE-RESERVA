"use client";

// iOS-style "wheel" time picker — two vertical scrollable columns
// (HH | MM) where the centred item is the selected value. Snaps via
// CSS scroll-snap; a 100ms scroll-end debounce commits the new value
// and fine-tunes the resting position (browsers occasionally miss
// the snap by a pixel or two).
//
// Why a custom wheel instead of <input type="time"> or a <select>:
//  - native time inputs render differently on every OS / locale and
//    don't let us hide invalid times
//  - <select> is functional but doesn't feel like a booking picker
//  - the wheel matches the iOS booking-app idiom the owner asked for
//
// Invalid minutes (lunch break) are pruned PER hour: the MM column
// rebuilds when HH changes so the user never sees a break minute.
// Whole-hours that are 100% break never appear in the HH column.

import { useCallback, useEffect, useMemo, useRef } from "react";

const ITEM_PX = 40;     // height of one item
const VISIBLE = 5;      // odd number, so there's a true centre row
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

  // Minutes that are still valid given the currently picked hour.
  // (Break windows trim this per-hour.)
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
    <div className="flex items-start gap-3 max-w-xs">
      <Wheel
        items={hours}
        value={selectedHour}
        label={hourLabel}
        onPick={onPickHour}
        disabled={disabled}
      />
      <Wheel
        items={minutes}
        value={selectedMin}
        label={minuteLabel}
        onPick={onPickMin}
        disabled={disabled}
      />
    </div>
  );
}

function Wheel({
  items, value, label, onPick, disabled
}: {
  items: string[];
  value: string;
  label: string;
  onPick: (v: string) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<number | undefined>(undefined);
  // Track the value we last committed so onScroll doesn't double-fire
  // when our own scrollTo lands on a slot.
  const lastCommittedRef = useRef<string>(value);

  // When `value` changes from the outside (e.g. hour pick changed the
  // valid minutes list and we re-snapped to a new minute), align the
  // wheel to it without animation.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const idx = items.indexOf(value);
    if (idx < 0) return;
    lastCommittedRef.current = value;
    el.scrollTop = idx * ITEM_PX;
  }, [items, value]);

  // Debounced scroll-end handler: snap to nearest slot, commit.
  function onScroll() {
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
      // Fine-tune the scroll position in case the snap missed by a px.
      const target = idx * ITEM_PX;
      if (Math.abs(el2.scrollTop - target) > 0.5) {
        el2.scrollTo({ top: target, behavior: "smooth" });
      }
      if (next !== lastCommittedRef.current) {
        lastCommittedRef.current = next;
        onPick(next);
      }
    }, 110);
  }

  return (
    <div className="flex-1 min-w-0">
      <div className="text-[11px] font-bold text-slate-500 mb-1 tracking-wider uppercase text-center">
        {label}
      </div>
      <div className="relative rounded-xl border border-slate-200 bg-white overflow-hidden">
        {/* Selection band — sits between the top fade and bottom fade,
            in the exact centre slot. Pointer-events-none so it doesn't
            block the scroll gestures. */}
        <div
          className="absolute inset-x-0 border-y border-brand/40 bg-brand/5 pointer-events-none z-[1]"
          style={{ top: CENTRE_TOP, height: ITEM_PX }}
        />
        {/* Top/bottom fade overlay (mask the non-selected items) */}
        <div
          className="absolute inset-x-0 top-0 pointer-events-none z-[2] bg-gradient-to-b from-white via-white/60 to-transparent"
          style={{ height: CENTRE_TOP }}
        />
        <div
          className="absolute inset-x-0 bottom-0 pointer-events-none z-[2] bg-gradient-to-t from-white via-white/60 to-transparent"
          style={{ height: CENTRE_TOP }}
        />
        {/* The scroll surface */}
        <div
          ref={ref}
          onScroll={onScroll}
          className="overflow-y-scroll snap-y snap-mandatory no-scrollbar touch-pan-y"
          style={{
            height: COLUMN_HEIGHT,
            scrollbarWidth: "none",
            msOverflowStyle: "none"
          }}
          aria-label={label}
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
                  // The debounced scroll handler will commit the value
                  // once the smooth scroll lands.
                }}
                className={`snap-center w-full flex items-center justify-center text-lg leading-none transition-colors ${
                  sel ? "font-bold text-brand" : "font-medium text-slate-500"
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
    </div>
  );
}
