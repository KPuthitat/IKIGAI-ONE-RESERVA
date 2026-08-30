"use client";

import { useLang } from "@/lib/LangProvider";

// Compact TH/EN toggle — ใช้ได้ทั้ง dark theme (ฉาก gradient) และ light theme (พื้นขาว)
// compact=true → ปุ่มสี่เหลี่ยมจัตุรัสปุ่มเดียว (สำหรับท็อปบาร์ ให้ขนาดเท่าปุ่มไอคอนอื่น)
// แตะเพื่อสลับภาษา; แสดงภาษาปัจจุบัน
export default function LangToggle({
  variant = "dark", compact = false
}: { variant?: "dark" | "light"; compact?: boolean }) {
  const { lang, setLang } = useLang();
  const isDark = variant === "dark";

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => setLang(lang === "th" ? "en" : "th")}
        aria-label="เปลี่ยนภาษา / switch language"
        title="เปลี่ยนภาษา / switch language"
        className={`flex-shrink-0 inline-flex items-center justify-center h-10 w-10 rounded-xl border text-xs font-bold tracking-[1px] transition-colors ${
          isDark
            ? "text-white border-white/20 bg-white/10 hover:bg-white/20"
            : "text-slate-700 border-slate-300 bg-white hover:bg-slate-100"
        }`}
      >{lang === "th" ? "TH" : "EN"}</button>
    );
  }

  const containerCls = isDark
    ? "bg-white/[.08] border-white/[.15]"
    : "bg-slate-100 border-slate-200";
  const inactiveCls = isDark ? "text-white/50" : "text-slate-500";

  function btn(target: "th" | "en") {
    const active = lang === target;
    return (
      <button
        type="button"
        onClick={() => setLang(target)}
        className={`px-3 py-1 text-xs font-bold tracking-[1px] rounded-md transition-all ${
          active
            ? "bg-brand text-white shadow-[0_2px_8px_rgba(160,104,32,.4)]"
            : inactiveCls
        }`}
      >{target === "th" ? "TH" : "EN"}</button>
    );
  }

  return (
    <div className={`inline-flex gap-0 border rounded-lg p-0.5 ${containerCls}`}>
      {btn("en")}
      {btn("th")}
    </div>
  );
}
