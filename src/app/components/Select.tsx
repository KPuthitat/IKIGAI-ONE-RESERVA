"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useAnchoredRect, anchorStyle } from "./dropdownPortal";

// System-styled select — the app's own dropdown (CI), replacing the browser's
// native <select> so the options menu matches the rest of the UI instead of
// the OS-native list. Choose-only (no free text); for searchable free-text use
// Combobox. The list renders in a portal so it escapes clipping ancestors.

export type SelectOption = { value: string; label: string; disabled?: boolean };

type Props = {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;       // shown when value matches no option
  className?: string;
  buttonClassName?: string;
  disabled?: boolean;
  title?: string;
  id?: string;
};

export default function Select({
  value, onChange, options, placeholder, className, buttonClassName, disabled, title, id
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const rect = useAnchoredRect(open, btnRef);

  const selected = options.find((o) => o.value === value);

  // Close on a click anywhere outside the button + the portal list.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (wrapRef.current?.contains(t)) return;
      if (t.closest("[data-select-pop]")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function choose(o: SelectOption) {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
    setActive(-1);
  }

  return (
    <div ref={wrapRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        id={id}
        ref={btnRef}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setOpen(false); setActive(-1); }
          else if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, options.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open && active >= 0) { e.preventDefault(); choose(options[active]); }
        }}
        className={`input w-full flex items-center justify-between gap-2 text-left ${buttonClassName ?? ""}`}
      >
        <span className={`truncate ${selected ? "" : "text-slate-400"}`}>
          {selected ? selected.label : (placeholder ?? "—")}
        </span>
        <svg className={`w-4 h-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && rect && createPortal(
        <ul
          data-select-pop
          style={anchorStyle(rect)}
          className="z-[60] min-w-[10rem] max-h-64 overflow-auto bg-white border border-slate-200 rounded-xl shadow-xl ring-1 ring-black/5 py-1 text-sm"
        >
          {options.map((o, i) => (
            <li
              key={o.value || `i${i}`}
              onMouseDown={(e) => { e.preventDefault(); choose(o); }}
              onMouseEnter={() => setActive(i)}
              className={`px-3 py-2 flex items-center justify-between gap-3 ${
                o.disabled
                  ? "text-slate-300 cursor-default"
                  : `cursor-pointer ${i === active ? "bg-brand/10" : "hover:bg-slate-50"}`
              } ${o.value === value ? "font-semibold text-brand" : "text-slate-700"}`}
            >
              <span className="truncate">{o.label}</span>
              {o.value === value && !o.disabled && (
                <svg className="w-4 h-4 shrink-0 text-brand" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
                </svg>
              )}
            </li>
          ))}
        </ul>,
        document.body
      )}
    </div>
  );
}
