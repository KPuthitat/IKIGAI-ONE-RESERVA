"use client";

import { useState, useRef, useEffect } from "react";

// System-styled combobox — replaces browser <datalist> autocompletes.
// Free-text input with a filtering dropdown of options (the app's own design).
//
// Usage:
//   <Combobox value={x} onChange={setX} options={["a", "b"]} placeholder="…" />

type Props = {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
  id?: string;
};

export default function Combobox({
  value,
  onChange,
  options,
  placeholder,
  className,
  inputClassName,
  disabled,
  id
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const q = (value ?? "").toLowerCase();
  const filtered = q
    ? options.filter((o) => o.toLowerCase().includes(q))
    : options;

  useEffect(() => {
    return () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    };
  }, []);

  function choose(o: string) {
    onChange(o);
    setOpen(false);
    setActive(-1);
  }

  return (
    <div className={`relative ${className ?? ""}`}>
      <input
        id={id}
        className={`input ${inputClassName ?? ""}`}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setActive(-1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            if (open && active >= 0 && active < filtered.length) {
              e.preventDefault();
              choose(filtered[active]);
            }
          }
        }}
      />
      {open && filtered.length > 0 && (
        <ul className="absolute left-0 right-0 top-full mt-1 z-50 max-h-56 overflow-auto bg-white border border-slate-200 rounded-lg shadow-lg text-sm">
          {filtered.map((o, i) => (
            <li
              key={o}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
              onMouseEnter={() => setActive(i)}
              className={`px-3 py-1.5 cursor-pointer ${
                i === active ? "bg-slate-100" : "hover:bg-slate-50"
              }`}
            >
              {o}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
