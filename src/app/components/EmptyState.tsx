// "Nothing here yet" panel with Nong Plara holding a sign (owner 2026-10-12).
// Drop-in for the ad-hoc `<div className="card text-sm text-slate-400 …">ไม่มีรายการ</div>`.
import * as React from "react";
import Mascot from "./Mascot";

export default function EmptyState({ children, size = 96, className = "" }: { children: React.ReactNode; size?: number; className?: string }) {
  return (
    <div className={`card flex flex-col items-center gap-2 py-6 text-center text-sm text-slate-400 ${className}`}>
      <Mascot pose="sign" size={size} />
      <div>{children}</div>
    </div>
  );
}
