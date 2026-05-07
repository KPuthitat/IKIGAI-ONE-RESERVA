"use client";

import { useEffect, useState } from "react";

// Reusable confirmation dialog — replaces window.confirm() / window.prompt().
// Provides app-styled modal with optional reason input + variants for severity.

export type ConfirmVariant = "default" | "danger" | "warning" | "info";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body?: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  variant?: ConfirmVariant;
  /** If true, show a single-line text input above the buttons. */
  withInput?: boolean;
  inputLabel?: string;
  inputPlaceholder?: string;
  inputDefaultValue?: string;
  /** If true, show only the confirm button (no cancel) — for alerts. */
  alertOnly?: boolean;
  /** Called with the input value (or "" if withInput is false) on confirm. */
  onConfirm: (value: string) => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
};

const VARIANT_CLASSES: Record<ConfirmVariant, string> = {
  default: "bg-brand text-white hover:opacity-90",
  danger:  "bg-rose-600 text-white hover:bg-rose-700",
  warning: "bg-amber-500 text-white hover:bg-amber-600",
  info:    "bg-sky-600 text-white hover:bg-sky-700"
};

export default function ConfirmModal({
  open, title, body, confirmLabel, cancelLabel, variant = "default",
  withInput = false, inputLabel, inputPlaceholder, inputDefaultValue = "",
  alertOnly = false,
  onConfirm, onCancel, busy = false
}: ConfirmDialogProps) {
  const [value, setValue] = useState(inputDefaultValue);

  useEffect(() => {
    if (open) setValue(inputDefaultValue);
  }, [open, inputDefaultValue]);

  // ESC to cancel
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={() => { if (!busy) onCancel(); }}
    >
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-slate-800 text-lg">{title}</h3>
        {body && <div className="text-sm text-slate-600">{body}</div>}

        {withInput && (
          <div>
            {inputLabel && <label className="label">{inputLabel}</label>}
            <input
              type="text"
              className="input w-full"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={inputPlaceholder}
              autoFocus
              disabled={busy}
            />
          </div>
        )}

        <div className="flex gap-2 pt-1">
          {!alertOnly && (
            <button
              type="button" onClick={onCancel} disabled={busy}
              className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium disabled:opacity-50"
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => onConfirm(value)}
            disabled={busy}
            className={`flex-1 py-2.5 rounded-lg text-sm font-bold disabled:opacity-50 ${VARIANT_CLASSES[variant]}`}
          >
            {busy ? "…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
