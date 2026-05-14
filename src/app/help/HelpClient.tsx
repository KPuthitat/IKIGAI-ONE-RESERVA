"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import OwlMascot from "../components/OwlMascot";
import {
  FAQ_CATEGORIES,
  searchFaq,
  type FaqCategory,
  type FaqEntry
} from "@/lib/owl-faq";
import { useLang } from "@/lib/LangProvider";

export default function HelpClient() {
  const { lang } = useLang();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<FaqCategory | "">("");
  const [openId, setOpenId] = useState<string | null>(null);

  const results = useMemo<FaqEntry[]>(() => {
    return searchFaq(q, {
      category: cat || undefined,
      lang: lang === "en" ? "en" : "th"
    });
  }, [q, cat, lang]);

  return (
    <div className="space-y-4">
      <div className="card">
        <input
          type="search"
          className="input text-base"
          placeholder={lang === "en" ? "Type a question…" : "พิมพ์คำถามที่ต้องการ…"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button"
          onClick={() => setCat("")}
          className={`text-xs px-3 py-1.5 rounded-full border ${
            cat === ""
              ? "bg-brand text-white border-brand"
              : "bg-white text-slate-700 border-slate-200 hover:border-brand"
          }`}>
          {lang === "en" ? "All" : "ทั้งหมด"}
        </button>
        {FAQ_CATEGORIES.map((c) => (
          <button key={c.id} type="button"
            onClick={() => setCat(cat === c.id ? "" : c.id)}
            className={`text-xs px-3 py-1.5 rounded-full border ${
              cat === c.id
                ? "bg-brand text-white border-brand"
                : "bg-white text-slate-700 border-slate-200 hover:border-brand"
            }`}>
            {lang === "en" ? c.label_en : c.label_th}
          </button>
        ))}
      </div>

      {results.length === 0 ? (
        <div className="card text-center py-10">
          <OwlMascot size={96} mood="thinking" />
          <p className="text-sm text-slate-600 mt-3">
            {lang === "en"
              ? "Hmm, I don't have an answer for that yet."
              : "ยังไม่มีคำตอบสำหรับคำถามนี้ครับ"}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {lang === "en"
              ? "Try a different search term or pick a category above."
              : "ลองพิมพ์คำใหม่ หรือเลือกหมวดด้านบนดูครับ"}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {results.map((entry) => {
            const isOpen = openId === entry.id;
            const cat = FAQ_CATEGORIES.find((c) => c.id === entry.category);
            return (
              <li key={entry.id} className="card p-0 overflow-hidden">
                <button type="button"
                  onClick={() => setOpenId(isOpen ? null : entry.id)}
                  className="w-full text-left p-4 flex items-start gap-3 hover:bg-slate-50">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-slate-800">
                      {lang === "en" ? entry.question_en : entry.question_th}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {lang === "en" ? cat?.label_en : cat?.label_th}
                      {entry.audience !== "any" && (
                        <span className="ml-2 px-1.5 py-0.5 rounded bg-slate-100">
                          {entry.audience === "admin" ? "Admin" : "Staff"}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="text-slate-400 text-xl">{isOpen ? "−" : "+"}</span>
                </button>
                {isOpen && (
                  <div className="px-4 pb-4 border-t border-slate-100 pt-3">
                    <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
                      {lang === "en" ? entry.answer_en : entry.answer_th}
                    </div>
                    {entry.link && (
                      <Link href={entry.link.href}
                        className="inline-block mt-3 text-sm text-brand font-bold underline">
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
  );
}
