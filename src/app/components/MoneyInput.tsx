"use client";

// A baht amount field that shows thousand separators while typing
// (owner 2026-10-02: "ชอบลืม thousand separator"). The VALUE handed back is the
// plain digit string ("600000"); the display is "600,000". Digits only — an
// amount field never needs decimals here.

export function digitsOnly(s: string): string {
  return s.replace(/[^\d]/g, "");
}
export function withCommas(digits: string): string {
  const d = digitsOnly(digits);
  return d ? Number(d).toLocaleString("en-US") : "";
}

export default function MoneyInput({
  value, onChange, placeholder, className, ariaLabel
}: {
  value: string;                       // digit string, "" = empty
  onChange: (digits: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <input
      type="text" inputMode="numeric" autoComplete="off"
      value={withCommas(value)}
      onChange={(e) => onChange(digitsOnly(e.target.value))}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={`input tabular-nums text-right ${className ?? ""}`}
    />
  );
}
