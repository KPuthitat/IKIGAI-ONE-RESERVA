"use client";

import { useState, useEffect } from "react";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";

// In-app month picker — replaces the browser's native <input type="month">
// so the UX is consistent across operating systems / browsers.
//
// Click the button → opens a modal with a 12-month grid + year arrows.
// Returns "YYYY-MM" via onChange.

const TH_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];
const EN_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

export default function MonthPicker({
  value, onChange, lang
}: {
  value: string;            // YYYY-MM
  onChange: (v: string) => void;
  lang: Lang;
}) {
  const [open, setOpen] = useState(false);
  const months = lang === "th" ? TH_MONTHS : EN_MONTHS;

  const [selY, selM] = value.split("-").map(Number);
  const [draftYear, setDraftYear] = useState(selY);

  useEffect(() => {
    if (open) setDraftYear(selY);
  }, [open, selY]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function pickMonth(m: number): void {
    const v = `${draftYear}-${String(m + 1).padStart(2, "0")}`;
    onChange(v);
    setOpen(false);
  }

  // Display label on the button — full Thai or English with year
  const yearDisplay = lang === "th" ? `${selY + 543}` : `${selY}`;
  const monthDisplay = months[selM - 1];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:border-brand/50 hover:bg-slate-50 text-sm font-medium text-slate-700 whitespace-nowrap shadow-sm transition"
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" d="M8 7V3m8 4V3M3 11h18M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
        </svg>
        <span>{monthDisplay} {yearDisplay}</span>
        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 ml-1" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-sm w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Year header with arrows */}
            <div className="flex items-center justify-between mb-4">
              <button
                type="button"
                onClick={() => setDraftYear((y) => y - 1)}
                className="w-9 h-9 rounded-lg hover:bg-slate-100 text-slate-600 flex items-center justify-center"
              >
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <div className="text-lg font-semibold text-slate-800">
                {lang === "th" ? `พ.ศ. ${draftYear + 543}` : draftYear}
              </div>
              <button
                type="button"
                onClick={() => setDraftYear((y) => y + 1)}
                className="w-9 h-9 rounded-lg hover:bg-slate-100 text-slate-600 flex items-center justify-center"
              >
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>

            {/* 12-month grid (3 cols) */}
            <div className="grid grid-cols-3 gap-2">
              {months.map((m, i) => {
                const isSelected = draftYear === selY && i + 1 === selM;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => pickMonth(i)}
                    className={`py-3 rounded-lg text-sm font-medium transition ${
                      isSelected
                        ? "bg-brand text-white"
                        : "bg-slate-50 text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    {m}
                  </button>
                );
              })}
            </div>

            {/* Footer */}
            <div className="flex justify-end mt-4">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                {t(lang, "common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
