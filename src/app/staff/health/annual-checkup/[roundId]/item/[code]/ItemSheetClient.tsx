"use client";

import { useRef, useState } from "react";
import ChoiceField from "../../../ChoiceField";
import { glueCompany } from "@/lib/text";
import { useRouter } from "next/navigation";
import { post } from "../../../shared";
import { DEFAULT_THRESHOLDS, FLAG_TH, withArrow, flagResult, isCritical, refLabel, type Flag } from "@/lib/health-report/interpret";
import type { Ref } from "@/lib/health-report/catalog";

type Item = { code: string; en: string; th: string; unit: string | null; kind: "number" | "choice" | "text"; choices: string[] | null; normal: string[] | "any" | null; refs: Ref[]; refText: string | null; plausible: [number, number] | null };
type Person = { orderId: number; key: string; label: string; code: string | null; external: boolean; payer: string; sex: "M" | "F" | null; age: number | null; locked: boolean; value: number | string | null };
const FLAG_CLS: Record<Flag, string> = { normal: "text-emerald-700", low: "text-sky-700 font-semibold", high: "text-rose-700 font-semibold", abnormal: "text-rose-700 font-semibold", info: "text-slate-500" };

export default function ItemSheetClient({ roundId, current, groups, item, people, enzymeMultiple }: {
  roundId: number; current: string; groups: Array<{ key: string; th: string; items: Array<{ code: string; label: string }> }>; item: Item; people: Person[]; enzymeMultiple: number;
}) {
  const router = useRouter();
  const [vals, setVals] = useState<Record<number, string>>(() => Object.fromEntries(people.map((p) => [p.orderId, p.value == null ? "" : String(p.value)])));
  const saved = useRef<Record<number, string>>({ ...vals });
  const [st, setSt] = useState<Record<number, string>>({});
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const [q, setQ] = useState("");
  const [who, setWho] = useState<"all" | "staff" | "ext">("all");
  const th = { ...DEFAULT_THRESHOLDS, enzymeMultiple };

  const save = async (p: Person, raw: string) => {
    const t = raw.trim();
    const v = t === "" ? null : item.kind === "number" ? Number(t) : t;
    if (typeof v === "number" && !Number.isFinite(v)) return;
    setSt((s) => ({ ...s, [p.orderId]: "…" }));
    let r = await post("items", { orderId: p.orderId, values: { [item.code]: v }, merge: true });
    if (!r.ok && r.error === "implausible") {
      if (window.confirm(`${p.label}: ค่า ${t} ผิดปกติมากจนอาจพิมพ์ผิด\nตรวจสอบแล้วและยืนยันให้บันทึกหรือไม่?`)) r = await post("items", { orderId: p.orderId, values: { [item.code]: v }, merge: true, confirmImplausible: true });
      else { setVals((s) => ({ ...s, [p.orderId]: saved.current[p.orderId] })); setSt((s) => ({ ...s, [p.orderId]: "" })); return; }
    }
    if (r.ok) { saved.current[p.orderId] = raw; setSt((s) => ({ ...s, [p.orderId]: "✓" })); } else setSt((s) => ({ ...s, [p.orderId]: `✗ ${r.message ?? "ไม่สำเร็จ"}` }));
  };
  const change = (p: Person, raw: string) => {
    setVals((s) => ({ ...s, [p.orderId]: raw }));
    clearTimeout(timers.current[p.orderId]);
    timers.current[p.orderId] = setTimeout(() => save(p, raw), 700);
  };
  const nextField = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-entry]:not([disabled])"));
    els[els.indexOf(e.currentTarget as HTMLElement) + 1]?.focus();
  };
  const shown = people.filter((p) => (who === "all" || (who === "ext") === p.external) && (!q.trim() || `${p.label} ${p.code ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())));
  const done = people.filter((p) => (vals[p.orderId] ?? "").trim() !== "").length;
  const ref = refLabel({ refs: item.refs, refText: item.refText ?? undefined });

  return (
    <div className="space-y-3">
      <div className="card space-y-2">
        <label className="block text-xs text-slate-500">รายการที่กำลังกรอก</label>
        <select className="input min-h-[44px] w-full" value={current} onChange={(e) => router.push(`/staff/health/annual-checkup/${roundId}/item/${e.target.value}`)}>
          {groups.map((g) => <optgroup key={g.key} label={g.th}>{g.items.map((i) => <option key={i.code} value={i.code}>{i.label}</option>)}</optgroup>)}
        </select>
        <div className="text-sm text-slate-700"><b>{item.en}</b> — {item.th}</div>
        <div className="text-xs text-slate-500">หน่วย {item.unit || "—"} · อ้างอิง {ref ? ref.replace(/\n/g, " / ") : "—"} · กรอกแล้ว {done}/{people.length} คน</div>
        <input className="input min-h-[44px] w-full" placeholder="ค้นหาชื่อหรือรหัสพนักงาน" value={q} onChange={(e) => setQ(e.target.value)} />
        {people.some((p) => p.external) && <div className="flex flex-wrap gap-2">{([["all", "ทั้งหมด"], ["staff", "พนักงาน"], ["ext", "ภายนอก"]] as const).map(([v, th]) => <button key={v} type="button" className={`chip min-h-[44px] ${who === v ? "chip-active" : ""}`} onClick={() => setWho(v)}>{th}</button>)}</div>}
      </div>
      <div className="card divide-y divide-slate-100">
        {people.length === 0 && <p className="text-sm text-slate-500">ไม่มีใครในรอบนี้ที่ต้องตรวจรายการนี้</p>}
        {shown.map((p) => {
          const raw = vals[p.orderId] ?? "";
          const n = item.kind === "number" && raw.trim() !== "" ? Number(raw) : null;
          const value = item.kind === "number" ? (n != null && Number.isFinite(n) ? n : null) : raw.trim() === "" ? null : raw;
          const flag = flagResult({ kind: item.kind, refs: item.refs, normal: item.normal ?? undefined }, value, p.sex, p.age);
          const crit = typeof value === "number" && isCritical({ code: item.code, refs: item.refs }, value, p.sex, p.age, th);
          return (
            <div key={p.orderId} className="py-2.5 grid gap-y-1.5 sm:grid-cols-[1fr_auto] sm:gap-x-3 items-center">
              <div className="min-w-0"><div className="text-sm font-medium text-slate-800 break-words">{p.label}{p.external && <span className="ml-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-800">ภายนอก · {glueCompany(p.payer)}</span>}</div><div className="text-xs text-slate-500">{p.code ?? "ผู้เข้าตรวจภายนอก"} · {p.sex === "M" ? "ชาย" : p.sex === "F" ? "หญิง" : "ไม่ระบุเพศ"}{p.age != null ? ` · ${p.age} ปี` : ""}{p.locked ? " · 🔒\u00A0ตรวจสอบแล้ว" : ""}</div></div>
              <div className="flex items-center gap-2">
                {item.kind === "choice" ? (
                  <ChoiceField value={raw} choices={item.choices ?? []} disabled={p.locked} onKeyDown={nextField} label={item.en} onChange={(v) => change(p, v)} />
                ) : (
                  <input data-entry disabled={p.locked} inputMode={item.kind === "number" ? "decimal" : "text"} className="input min-h-[44px] w-32 text-right" value={raw} onKeyDown={nextField} aria-label={`${item.en} ของ ${p.label}`}
                    onChange={(e) => { const s = item.kind === "number" ? e.target.value.replace(",", ".") : e.target.value; if (item.kind !== "number" || /^-?\d*\.?\d*$/.test(s)) change(p, s); }} />
                )}
                <span className={`w-24 text-xs ${flag ? FLAG_CLS[flag] : ""}`}>{flag && flag !== "info" ? (flag === "normal" ? "ปกติ" : withArrow(FLAG_TH[flag])) : ""}{crit ? <span className="block text-rose-700 font-bold">⚠ แจ้งแพทย์</span> : null}</span>
                <span className="w-6 text-xs text-slate-400" aria-live="polite">{st[p.orderId] ?? ""}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
