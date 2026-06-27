"use client";

import { useState, useRef, useEffect } from "react";

// System-styled combobox — replaces browser <datalist> autocompletes.
// Free-text input with a filtering dropdown of options (the app's own design).
//
// Options can be plain strings, or objects with an optional `hint` (shown
// muted on the right — e.g. a tax id) and `search` text (extra keywords to
// match against, so a vendor can be found by typing its tax id even though
// only the name is displayed).
//
// Usage:
//   <Combobox value={x} onChange={setX} options={["a", "b"]} />
//   <Combobox value={x} onChange={setX}
//     options={[{ value: "ABC Co.", hint: "0105500…", search: "ABC Co. 0105500…" }]} />

export type ComboOption = string | { value: string; hint?: string; search?: string };

type Norm = { value: string; hint?: string; search: string };

type Props = {
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
  id?: string;
};

function norm(o: ComboOption): Norm {
  if (typeof o === "string") return { value: o, search: o };
  return { value: o.value, hint: o.hint, search: o.search ?? `${o.value} ${o.hint ?? ""}` };
}

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

  const all = options.map(norm);
  const q = (value ?? "").trim().toLowerCase();
  const filtered = q
    ? all.filter((o) => o.search.toLowerCase().includes(q))
    : all;

  useEffect(() => {
    return () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    };
  }, []);

  function choose(o: Norm) {
    onChange(o.value);
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
        <ul className="absolute left-0 right-0 top-full mt-1.5 z-50 min-w-[16rem] max-h-64 overflow-auto bg-white border border-slate-200 rounded-xl shadow-xl ring-1 ring-black/5 py-1 text-sm">
          {filtered.map((o, i) => (
            <li
              key={`${o.value}-${i}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
              onMouseEnter={() => setActive(i)}
              className={`px-3 py-2 cursor-pointer flex items-center justify-between gap-3 ${
                i === active ? "bg-brand/10" : "hover:bg-slate-50"
              }`}
            >
              <span className="truncate text-slate-700">{o.value}</span>
              {o.hint && (
                <span className="shrink-0 font-mono text-[11px] text-slate-400 tabular-nums">{o.hint}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
