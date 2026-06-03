"use client";

import { useLang } from "@/lib/LangProvider";

// Compact TH/EN toggle — ใช้ได้ทั้ง dark theme (ฉาก gradient) และ light theme (พื้นขาว)
export default function LangToggle({
  variant = "dark"
}: { variant?: "dark" | "light" }) {
  const { lang, setLang } = useLang();
  const isDark = variant === "dark";
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
