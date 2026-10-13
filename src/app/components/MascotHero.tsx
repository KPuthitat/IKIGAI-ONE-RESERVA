// Big Nong Plara with a speech bubble — the headline mascot spot on the home pages
// (owner 2026-10-13: "อยากเห็นน้องปลาร้าตัวโตๆ"). The pose/line follow the Bangkok hour.
import * as React from "react";
import { bangkokHour, greetingForHour } from "@/lib/mascot-greeting";

export default function MascotHero({ name, children }: { name?: string; children?: React.ReactNode }) {
  const g = greetingForHour(bangkokHour());
  return (
    <div className="card relative overflow-hidden flex items-center gap-3 sm:gap-6 p-4 sm:p-6"
      style={{ background: "linear-gradient(120deg, var(--surface-field) 0%, #ffffff 70%)" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/mascot/${g.pose}.webp`} alt="" width={220} height={220}
        className="animate-owl-float flex-shrink-0 w-[128px] h-[128px] sm:w-[200px] sm:h-[200px] object-contain drop-shadow-md" />
      <div className="relative min-w-0 flex-1 sm:max-w-xl">
        <div className="relative rounded-2xl rounded-tl-sm bg-white border border-[color:var(--card-border)] shadow-card px-4 py-3">
          {name && <div className="text-xs font-bold text-brand mb-0.5">สวัสดี {name}</div>}
          <div className="text-base sm:text-xl font-bold text-slate-800 leading-snug">{g.text}</div>
          {children && <div className="text-sm text-slate-500 mt-1">{children}</div>}
        </div>
      </div>
    </div>
  );
}
