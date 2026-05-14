"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import OwlMascot from "./OwlMascot";
import {
  FAQ_CATEGORIES,
  searchFaq,
  type FaqAudience,
  type FaqCategory,
  type FaqEntry
} from "@/lib/owl-faq";
import { useLang } from "@/lib/LangProvider";

// HookFab — น้องฮูก floating helper.
//
// Pinned bottom-right of the viewport. Click it → expands a chat
// panel that shows:
//   • A greeting from น้องฮูก
//   • Quick category chips
//   • A search box that filters the FAQ list live
//   • Up to 8 matching FAQ entries (collapsed by default; tap to expand)
//   • A "เปิดห้องน้องฮูกแบบเต็ม" link to /help for the full experience
//
// Audience-aware: the admin layout passes audience="admin", staff
// layout passes "staff". The chat panel hides FAQ entries that
// don't apply to that role (e.g. staff doesn't see admin-only
// roster-publish answers).

export default function HookFab({
  audience = "any"
}: {
  audience?: FaqAudience;
}) {
  const { lang } = useLang();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<FaqCategory | "">("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Close the panel on Escape — feels native for a modal/popover.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const results = useMemo<FaqEntry[]>(() => {
    return searchFaq(q, {
      category: cat || undefined,
      audience,
      lang: lang === "en" ? "en" : "th"
    }).slice(0, 8);
  }, [q, cat, audience, lang]);

  // i18n strings inline — only ~10 strings, simpler than threading
  // through the global i18n dict for a non-critical surface.
  const T = lang === "en"
    ? {
        title: "Hi! I'm Hook",
        sub: "Pick a category or type a question",
        searchPh: "Type your question…",
        chipAll: "All",
        nope: "Hmm, I don't know that one yet. Open the help center?",
        openHelp: "Open the help center",
        seeAll: "See all FAQs"
      }
    : {
        title: "สวัสดีครับ ผมน้องฮูก",
        sub: "เลือกหมวด หรือพิมพ์คำถาม",
        searchPh: "พิมพ์คำถามที่ต้องการ…",
        chipAll: "ทั้งหมด",
        nope: "ยังไม่รู้คำตอบครับ ลองเปิดห้องน้องฮูกแบบเต็มดูครับ",
        openHelp: "เปิดห้องน้องฮูกแบบเต็ม",
        seeAll: "ดูคำถามทั้งหมด"
      };

  return (
    <>
      {/* FAB — bare owl, no circle wrapper. Hit target is generous
          via padding on the button itself, but visually only the
          owl shows. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={T.title}
        className={`fixed z-40 bottom-4 right-4 sm:bottom-6 sm:right-6
          p-1 transition transform
          ${open
            ? "scale-95 opacity-80"
            : "hover:scale-110 active:scale-95"}
        `}
      >
        <OwlMascot size={64} mood={open ? "smile" : "sleepy"} />
        {/* Tiny "?" hint dot, sits at the top-right of the owl. */}
        {!open && (
          <span className="absolute top-0 right-0 bg-brand text-white text-[10px]
              font-bold rounded-full w-5 h-5 flex items-center justify-center
              shadow-md">
            ?
          </span>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div
          className="fixed z-50 bottom-20 right-4 sm:bottom-24 sm:right-6
            w-[min(380px,calc(100vw-2rem))] max-h-[min(560px,calc(100vh-7rem))]
            bg-white rounded-2xl shadow-2xl border border-slate-200
            flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="bg-amber-50 border-b border-amber-200 px-4 py-3 flex items-start gap-3">
            <OwlMascot size={52} mood="wink" showCoffee={false} />
            <div className="flex-1 min-w-0">
              <div className="font-bold text-slate-800 text-sm">{T.title}</div>
              <div className="text-xs text-slate-500">{T.sub}</div>
            </div>
            <button type="button" onClick={() => setOpen(false)}
              aria-label="ปิด"
              className="text-slate-400 hover:text-slate-600 text-xl leading-none">
              ×
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {/* Search */}
            <input
              type="text"
              className="input text-sm"
              placeholder={T.searchPh}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />

            {/* Category chips */}
            <div className="flex flex-wrap gap-1.5">
              <button type="button"
                onClick={() => setCat("")}
                className={`text-[11px] px-2 py-0.5 rounded-full border ${
                  cat === ""
                    ? "bg-brand text-white border-brand"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}>
                {T.chipAll}
              </button>
              {FAQ_CATEGORIES.map((c) => (
                <button key={c.id} type="button"
                  onClick={() => setCat(cat === c.id ? "" : c.id)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border ${
                    cat === c.id
                      ? "bg-brand text-white border-brand"
                      : "border-slate-300 text-slate-600 hover:bg-slate-50"
                  }`}>
                  {lang === "en" ? c.label_en : c.label_th}
                </button>
              ))}
            </div>

            {/* Results */}
            {results.length === 0 ? (
              <div className="text-center py-6">
                <OwlMascot size={64} mood="thinking" />
                <p className="text-xs text-slate-500 mt-2">{T.nope}</p>
                <Link href="/help" onClick={() => setOpen(false)}
                  className="inline-block mt-3 text-sm text-brand font-bold underline">
                  {T.openHelp}
                </Link>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {results.map((entry) => {
                  const expanded = expandedId === entry.id;
                  const cat = FAQ_CATEGORIES.find((c) => c.id === entry.category);
                  return (
                    <li key={entry.id} className="border border-slate-200 rounded-lg">
                      <button type="button"
                        onClick={() => setExpandedId(expanded ? null : entry.id)}
                        className="w-full text-left p-2.5 flex items-start gap-2 hover:bg-slate-50">
                        <span className="text-sm font-bold text-slate-800 flex-1">
                          {lang === "en" ? entry.question_en : entry.question_th}
                        </span>
                        <span className="text-slate-400 flex-shrink-0">
                          {expanded ? "−" : "+"}
                        </span>
                      </button>
                      {expanded && (
                        <div className="px-3 pb-3 border-t border-slate-100 pt-2">
                          <div className="text-xs text-slate-700 whitespace-pre-wrap leading-relaxed">
                            {lang === "en" ? entry.answer_en : entry.answer_th}
                          </div>
                          {entry.link && (
                            <Link href={entry.link.href}
                              onClick={() => setOpen(false)}
                              className="inline-block mt-2 text-xs text-brand font-bold underline">
                              → {lang === "en" ? entry.link.label_en : entry.link.label_th}
                            </Link>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-slate-200 p-2 bg-slate-50/50 text-center">
            <Link href="/help" onClick={() => setOpen(false)}
              className="text-xs text-brand font-bold hover:underline">
              {T.seeAll} →
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
