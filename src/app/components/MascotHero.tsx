// Big Nong Plara with a speech bubble — the headline mascot spot on the home pages
// (owner 2026-10-13: "อยากเห็นน้องปลาร้าตัวโตๆ", "อยู่นิ่งๆ ก็ได้"). The pose/line follow the Bangkok hour.
// The card is only as tall as the mascot and the bubble fills the rest, with a tail towards him.
import * as React from "react";
import { bangkokHour, greetingForHour } from "@/lib/mascot-greeting";

export default function MascotHero({ name, children }: { name?: string; children?: React.ReactNode }) {
  const g = greetingForHour(bangkokHour());
  return (
    <div className="card flex items-center gap-3 sm:gap-5 p-3 sm:p-4 overflow-hidden"
      style={{ background: "linear-gradient(120deg, var(--surface-field) 0%, #ffffff 80%)" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/mascot/${g.pose}.webp`} alt="" width={180} height={180}
        className="flex-shrink-0 w-[112px] h-[112px] sm:w-[176px] sm:h-[176px] object-contain drop-shadow-md" />
      <div className="relative flex-1 min-w-0">
        <span aria-hidden className="absolute -left-[7px] top-1/2 -translate-y-1/2 rotate-45 h-3.5 w-3.5 bg-white border-l border-b border-[color:var(--card-border)]" />
        <div className="relative rounded-2xl bg-white border border-[color:var(--card-border)] shadow-card px-4 py-3 sm:px-7 sm:py-6">
          {name && <div className="text-xs sm:text-sm font-bold text-brand mb-1">สวัสดี {name}</div>}
          <div className="text-lg sm:text-3xl font-bold text-slate-800 leading-snug">{g.text}</div>
          {children && <div className="text-sm sm:text-base text-slate-500 mt-1.5">{children}</div>}
        </div>
      </div>
    </div>
  );
}
