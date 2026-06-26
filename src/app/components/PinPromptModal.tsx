"use client";

import { useState } from "react";

/**
 * PinPromptModal — reusable 4-digit PIN gate.
 *
 * Pattern: caller renders this when a high-trust action is about to run.
 *   - `onSubmit(pin)` receives the 4-digit PIN and should POST it to the
 *     relevant API route alongside the action payload.
 *   - Returns `{ ok: true }` on success, `{ ok: false; message }` on failure.
 *   - Error messages from the server ("wrong_pin", "no_pin" etc.) are surfaced
 *     inline so the user can retry without losing their form state.
 *
 * The PIN is the same 4-digit users.pin_hash that the time-clock uses —
 * no separate setup required (owner 2026-06-01: "ทุกคนตอนสมัครบังคับสร้าง
 * PIN อยู่แล้ว").
 */
export default function PinPromptModal({
  title, description, submitLabel, onSubmit, onClose
}: {
  title: string;
  description: React.ReactNode;
  submitLabel: string;
  onSubmit: (pin: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  onClose: () => void;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!/^\d{4}$/.test(pin)) {
      setErr("PIN ต้องเป็นตัวเลข 4 หลัก");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await onSubmit(pin);
      if (!res.ok) setErr(res.message);
    } finally { setBusy(false); }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="font-bold text-slate-800">{title}</h3>
          <div className="text-xs text-slate-600 mt-1 leading-relaxed">{description}</div>
        </div>
        <div>
          <label className="label">PIN (4 หลัก)</label>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            maxLength={4}
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
              setErr(null);
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) void submit(); }}
            className="input font-mono text-center text-2xl tracking-[10px]"
          />
        </div>
        {err && (
          <p className="text-rose-600 text-xs font-medium">
            {err === "pin_invalid" || err === "wrong_pin"
              ? "✗ PIN ไม่ถูกต้อง"
              : err === "no_pin" || err === "user_pin_not_set"
                ? <span>
                    ✗ ยังไม่ได้ตั้ง PIN —{" "}
                    <a href="/staff/persona" className="underline text-rose-700 hover:text-rose-800">
                      ไปตั้งที่หน้าลงเวลา
                    </a>
                  </span>
                : `✗ ${err}`}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium disabled:opacity-50"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || pin.length < 4}
            className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50"
          >
            {busy ? "กำลังส่ง…" : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
