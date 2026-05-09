"use client";

import { useState } from "react";
import { useLang } from "@/lib/LangProvider";

// Reason picker shown when admin cancels a booking. The selected reason
// (preset or custom free text) is passed to the parent's onConfirm
// callback, which forwards it to the cancel API. Server pushes a Flex
// card to the customer with this exact reason in the body.
//
// Three preset options:
//   no_table     "ไม่มีโต๊ะว่างในเวลาที่จอง"
//   temp_closed  "ร้านปิดทำการชั่วคราว"
//   other        free-text input shown only when this is selected

type PresetKey = "no_table" | "temp_closed" | "other";

const PRESET_KEYS: Array<{ value: PresetKey; labelKey: string }> = [
  { value: "no_table", labelKey: "admin.bookings.cancelReason.no_table" },
  { value: "temp_closed", labelKey: "admin.bookings.cancelReason.temp_closed" },
  { value: "other", labelKey: "admin.bookings.cancelReason.other" }
];

export default function CancelReasonModal({
  bookingRef,
  busy,
  onClose,
  onConfirm
}: {
  bookingRef: string | null;
  busy: boolean;
  onClose: () => void;
  /** Resolves with the final reason string the parent should send to the
   *  cancel API. Empty string means admin didn't pick anything; the parent
   *  decides whether to allow that. */
  onConfirm: (reason: string) => void;
}) {
  const { t } = useLang();
  const [picked, setPicked] = useState<PresetKey | "">("");
  const [customText, setCustomText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    setErr(null);
    if (!picked) {
      setErr(t("admin.bookings.cancelReason.errPick"));
      return;
    }
    let finalReason: string;
    if (picked === "other") {
      const trimmed = customText.trim();
      if (!trimmed) {
        setErr(t("admin.bookings.cancelReason.errCustomEmpty"));
        return;
      }
      finalReason = trimmed;
    } else {
      // Resolve the preset key into the same Thai label customers will see
      // — passing the localized string straight through means the Flex
      // card body matches the admin UI 1:1.
      finalReason = t(`admin.bookings.cancelReason.${picked}`);
    }
    onConfirm(finalReason);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 my-8 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-800 text-lg">
              {t("admin.bookings.cancelReason.title")}
            </h2>
            {bookingRef && (
              <p className="text-xs text-slate-500 mt-1">
                {t("admin.bookings.cancelReason.subtitle", { ref: bookingRef })}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2"
          >×</button>
        </div>

        <div className="space-y-2">
          {PRESET_KEYS.map((p) => {
            const selected = picked === p.value;
            return (
              <label
                key={p.value}
                className={`block border-[1.5px] rounded-xl p-3.5 cursor-pointer transition ${
                  selected
                    ? "border-rose-400 bg-rose-50"
                    : "border-slate-200 hover:border-slate-300"
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    className="mt-1 w-4 h-4"
                    checked={selected}
                    onChange={() => setPicked(p.value)}
                  />
                  <div className="font-medium text-slate-800">{t(p.labelKey)}</div>
                </div>
                {selected && p.value === "other" && (
                  <textarea
                    className="input mt-3"
                    rows={3}
                    maxLength={500}
                    autoFocus
                    placeholder={t("admin.bookings.cancelReason.customPlaceholder")}
                    value={customText}
                    onChange={(e) => setCustomText(e.target.value)}
                  />
                )}
              </label>
            );
          })}
        </div>

        {err && (
          <div className="text-rose-600 text-sm">{err}</div>
        )}

        <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-xs p-3">
          {t("admin.bookings.cancelReason.flexNotice")}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="btn-secondary text-sm"
          >
            {t("common.back")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="btn-danger text-sm"
          >
            {busy ? "…" : t("admin.bookings.cancelReason.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
