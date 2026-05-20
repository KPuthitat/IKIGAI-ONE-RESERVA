"use client";

// iOS-style toggle switch — shared across the app so every on/off
// setting looks and behaves the same.
//
// Implementation note: this is a real <input type="checkbox"> hidden
// behind `peer sr-only`, with the visual track + thumb styled via
// `peer-checked:`. That means a surrounding <label> still toggles the
// state on click (preserving the existing UX of every label/checkbox
// pair we replace), no extra onClick plumbing required.
//
// Drop-in usage:
//   <Switch checked={x} onChange={set} />
//   <Switch checked={x} onChange={set} accent="emerald" size="sm" />

type Accent = "brand" | "rose" | "sky" | "emerald" | "amber";

export default function Switch({
  checked, onChange, disabled = false,
  accent = "brand", size = "md",
  id, "aria-label": ariaLabel
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  accent?: Accent;
  size?: "sm" | "md";
  id?: string;
  "aria-label"?: string;
}) {
  const accentOn: Record<Accent, string> = {
    brand:   "peer-checked:bg-brand",
    rose:    "peer-checked:bg-rose-500",
    sky:     "peer-checked:bg-sky-500",
    emerald: "peer-checked:bg-emerald-500",
    amber:   "peer-checked:bg-amber-500"
  };
  const trackSize  = size === "sm" ? "h-5 w-9"  : "h-6 w-11";
  const thumbSize  = size === "sm" ? "h-4 w-4"  : "h-5 w-5";
  const thumbOn    = size === "sm" ? "peer-checked:translate-x-4" : "peer-checked:translate-x-5";

  return (
    <span className={`relative inline-flex items-center flex-shrink-0 ${disabled ? "opacity-50" : ""}`}>
      <input
        type="checkbox"
        id={id}
        aria-label={ariaLabel}
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className={`inline-flex items-center rounded-full bg-slate-300 transition-colors ${trackSize} ${accentOn[accent]} ${
          disabled ? "" : "cursor-pointer"
        }`}
      >
        <span
          className={`inline-block transform rounded-full bg-white shadow transition-transform translate-x-0.5 ${thumbSize} ${thumbOn}`}
        />
      </span>
    </span>
  );
}
