"use client";

import type { Flow, FlowStep, StepState } from "@/lib/purchase-flow";

// The purchase flow chart (owner 2026-11-26): every step of Memo → PR → PO → goods → bills with who has done it and who it is waiting for.
// Desktop: steps side by side; phone: one under another. The step the purchase is at right now is highlighted.
const TONE: Record<StepState, { ring: string; dot: string; text: string; label: string }> = {
  done: { ring: "border-emerald-300 bg-emerald-50", dot: "bg-emerald-500 text-white", text: "text-emerald-900", label: "เสร็จแล้ว" },
  current: { ring: "border-brand bg-brand/5 ring-2 ring-brand/30", dot: "nk-gradient text-white", text: "text-slate-900", label: "ตอนนี้อยู่ขั้นนี้" },
  todo: { ring: "border-slate-200 bg-white", dot: "bg-slate-200 text-slate-500", text: "text-slate-500", label: "ยังไม่ถึง" },
  skipped: { ring: "border-dashed border-slate-300 bg-slate-50", dot: "bg-slate-300 text-white", text: "text-slate-500", label: "ข้าม" },
  failed: { ring: "border-rose-300 bg-rose-50", dot: "bg-rose-500 text-white", text: "text-rose-900", label: "หยุดที่นี่" }
};
const MARK: Record<StepState, string> = { done: "✓", current: "●", todo: "", skipped: "–", failed: "✕" };

export function FlowHeadline({ flow }: { flow: Flow }) {
  const cls = flow.failed ? "bg-rose-50 border-rose-200 text-rose-900" : flow.finished ? "bg-emerald-50 border-emerald-200 text-emerald-900" : "bg-amber-50 border-amber-200 text-amber-900";
  return <div className={`rounded-xl border px-3 py-2 text-sm font-medium break-words ${cls}`} role="status">{flow.headline}</div>;
}

export default function PurchaseFlowChart({ flow, compact = false }: { flow: Flow; compact?: boolean }) {
  const detailed = flow.steps.filter((s) => s.state === "current" || s.lines.length > 0 || s.people.length > 0);
  return (
    <div className="space-y-3" aria-label="ขั้นตอนการจัดซื้อ">
      <FlowHeadline flow={flow} />
      {/* the whole road on one line: where the purchase has been and where it is now */}
      <ol className="flex items-start" aria-label="ลำดับขั้นตอน">
        {flow.steps.map((s, i) => {
          const t = TONE[s.state];
          return (
            <li key={s.key} className="relative flex-1 min-w-0 flex flex-col items-center text-center px-0.5" aria-current={s.state === "current" ? "step" : undefined}>
              {i > 0 && <span aria-hidden className={`absolute top-3 right-1/2 h-0.5 w-full -z-0 ${flow.steps[i - 1].state === "done" || flow.steps[i - 1].state === "skipped" ? "bg-emerald-300" : "bg-slate-200"}`} />}
              <span className={`relative z-10 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${t.dot} ${s.state === "current" ? "ring-4 ring-brand/20" : ""}`}>{MARK[s.state] || i + 1}</span>
              <span className={`mt-1 text-[10px] sm:text-xs leading-tight break-words ${s.state === "current" ? "font-bold text-slate-900" : t.text}`}>{s.label}</span>
              {s.state === "current" && <span className="mt-0.5 text-[9px] font-semibold text-brand">ตอนนี้อยู่ที่นี่</span>}
              {s.state === "skipped" && <span className="mt-0.5 text-[9px] text-slate-400">ข้าม</span>}
            </li>
          );
        })}
      </ol>
      {!compact && detailed.length > 0 && (
        <ul className="space-y-2">
          {detailed.map((s) => <Detail key={s.key} s={s} />)}
        </ul>
      )}
    </div>
  );
}

function Detail({ s }: { s: FlowStep }) {
  const t = TONE[s.state];
  return (
    <li className={`rounded-xl border p-3 ${t.ring}`}>
      <div className="flex items-center gap-2">
        <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${t.dot}`}>{MARK[s.state] || "·"}</span>
        <span className={`text-sm font-semibold break-words ${t.text}`}>{s.label}</span>
        <span className="text-[10px] uppercase tracking-wide text-slate-400">{t.label}</span>
      </div>
      {s.lines.length > 0 && <ul className="mt-1 space-y-0.5 text-xs text-slate-600">{s.lines.map((l, i) => <li key={i} className="break-words">{l}</li>)}</ul>}
      {s.people.length > 0 && (
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {s.people.map((p, i) => (
            <li key={i} className="flex items-center gap-2 text-xs">
              <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${p.status === "done" ? "bg-emerald-500 text-white" : p.status === "rejected" ? "bg-rose-500 text-white" : "bg-amber-200 text-amber-900"}`}>{p.status === "done" ? "✓" : p.status === "rejected" ? "✕" : "…"}</span>
              <span className="break-words min-w-0">{p.name}<span className="text-slate-400"> · {p.status === "done" ? "แล้ว" : p.status === "rejected" ? "ไม่เห็นชอบ" : "รออยู่"}</span></span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
