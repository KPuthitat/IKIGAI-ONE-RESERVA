"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { post, upload } from "../../../../shared";
import { apiUrl } from "@/lib/url";
import { bmi, bmiCategory, DEFAULT_THRESHOLDS, FLAG_TH, withArrow, flagResult, globulin, HEARING_FREQS, implausible, indirectBilirubin, interpretHearing, interpretSpirometry, isCritical, refLabel, type Flag } from "@/lib/health-report/interpret";
import type { Ref } from "@/lib/health-report/catalog";

type Vals = Record<string, string>;                          // what is typed (numbers stay text so "7." can be typed)
type Saved = Record<string, number | string | null>;
export type EntryItem = { code: string; en: string; th: string; unit: string | null; kind: "number" | "choice" | "text" | "file"; choices: string[] | null; normal: string[] | "any" | null; refs: Ref[]; refText: string | null; plausible: [number, number] | null; decimals: number | null; computed: "bmi" | "globulin" | "indirect_bili" | null };
export type EntryTest = { orderId: number; testCode: string; locked: boolean; items: EntryItem[]; values: Saved; file: { href: string } | null };
export type EntryTab = { key: string; th: string; en: string; tests: EntryTest[] };

const FLAG_CLS: Record<Flag, string> = { normal: "text-emerald-700", low: "text-sky-700 font-semibold", high: "text-rose-700 font-semibold", abnormal: "text-rose-700 font-semibold", info: "text-slate-500" };
const SAVE_MS = 700;

export default function EntryClient({ tabs, sex, age, enzymeMultiple }: { tabs: EntryTab[]; sex: "M" | "F" | null; age: number | null; enzymeMultiple: number }) {
  const [active, setActive] = useState(tabs[0].key);
  const asText = (x: Saved): Vals => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v == null ? "" : String(v)]));
  const kinds = useRef(Object.fromEntries(tabs.flatMap((t) => t.tests).map((x) => [x.orderId, Object.fromEntries(x.items.map((i) => [i.code, i.kind]))])) as Record<number, Record<string, string>>);
  const payload = (orderId: number, v: Vals): Saved => Object.fromEntries(Object.entries(v).map(([k, s]) => {
    const t = s.trim();
    if (t === "") return [k, null];
    if (kinds.current[orderId]?.[k] === "number") { const n = Number(t); return [k, Number.isFinite(n) ? n : null]; }
    return [k, t];
  }));
  const [vals, setVals] = useState<Record<number, Vals>>(() => Object.fromEntries(tabs.flatMap((t) => t.tests).map((x) => [x.orderId, asText(x.values)])));
  const [state, setState] = useState<Record<number, { s: "idle" | "saving" | "saved" | "error"; msg?: string; at?: string }>>({});
  const saved = useRef<Record<number, Vals>>(Object.fromEntries(tabs.flatMap((t) => t.tests).map((x) => [x.orderId, asText(x.values)])));
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const th = { ...DEFAULT_THRESHOLDS, enzymeMultiple };

  const save = useCallback(async (orderId: number, v: Vals) => {
    setState((s) => ({ ...s, [orderId]: { s: "saving" } }));
    let r = await post("items", { orderId, values: payload(orderId, v) });
    if (!r.ok && r.error === "implausible") {
      const codes = ((r.issues as Array<{ code: string }>) ?? []).map((i) => i.code).join(", ");
      if (window.confirm(`ค่าที่กรอกผิดปกติมากจนอาจพิมพ์ผิด (${codes})\nตรวจสอบแล้วและยืนยันให้บันทึกหรือไม่?`)) r = await post("items", { orderId, values: payload(orderId, v), confirmImplausible: true });
      else { setVals((s) => ({ ...s, [orderId]: { ...saved.current[orderId] } })); setState((s) => ({ ...s, [orderId]: { s: "idle" } })); return; }
    }
    if (r.ok) { saved.current[orderId] = { ...v }; setState((s) => ({ ...s, [orderId]: { s: "saved", at: new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) } })); }
    else setState((s) => ({ ...s, [orderId]: { s: "error", msg: r.message ?? "บันทึกไม่สำเร็จ" } }));
  }, []);

  const change = (orderId: number, code: string, v: string) => {
    setVals((s) => {
      const next = { ...s[orderId], [code]: v };
      clearTimeout(timers.current[orderId]);
      timers.current[orderId] = setTimeout(() => save(orderId, next), SAVE_MS);
      return { ...s, [orderId]: next };
    });
  };
  useEffect(() => () => { for (const t of Object.values(timers.current)) clearTimeout(t); }, []);
  // leaving the page with an unsaved change: flush it
  useEffect(() => {
    const flush = () => { for (const [id, t] of Object.entries(timers.current)) { clearTimeout(t); const v = vals[Number(id)]; if (v && JSON.stringify(v) !== JSON.stringify(saved.current[Number(id)])) navigator.sendBeacon?.(apiUrl("/api/annual-checkup/items"), new Blob([JSON.stringify({ orderId: Number(id), values: payload(Number(id), v) })], { type: "application/json" })); } };
    window.addEventListener("pagehide", flush); return () => window.removeEventListener("pagehide", flush);
  }, [vals]);

  const nextField = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-entry]:not([disabled])"));
    const i = els.indexOf(e.currentTarget as HTMLElement);
    els[i + 1]?.focus();
  };

  const tab = tabs.find((t) => t.key === active) ?? tabs[0];
  const pending = tabs.map((t) => ({ t, left: t.tests.reduce((n, x) => n + x.items.filter((i) => !i.computed && i.kind !== "file" && (vals[x.orderId]?.[i.code] ?? "").trim() === "").length, 0) }));

  // review before it goes to the doctor: what is still missing, and what is out of range
  const review = (() => {
    const flagged: string[] = [], critical: string[] = [];
    for (const t of tabs) for (const x of t.tests) for (const it of x.items) {
      if (it.kind === "file") continue;
      const v = vals[x.orderId] ?? {};
      const txt = (v[it.code] ?? "").trim();
      let value: number | string | null = txt === "" ? null : txt;
      if (it.kind === "number" && txt !== "") { const n = Number(txt); value = Number.isFinite(n) ? n : null; }
      if (it.computed || value == null) continue;
      const f = flagResult({ kind: it.kind, refs: it.refs, normal: it.normal ?? undefined }, value, sex, age);
      if (f && f !== "normal" && f !== "info") flagged.push(`${it.en} ${typeof value === "number" ? value : String(value)} (${FLAG_TH[f]})`);
      if (typeof value === "number" && isCritical({ code: it.code, refs: it.refs }, value, sex, age, th)) critical.push(`${it.en} ${value}`);
    }
    return { flagged, critical };
  })();
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist">
        {pending.map(({ t, left }) => (
          <button key={t.key} type="button" role="tab" aria-selected={t.key === active} onClick={() => setActive(t.key)}
            className={`shrink-0 rounded-lg border px-3 min-h-[44px] text-sm ${t.key === active ? "bg-brand text-white border-brand" : "bg-white text-slate-700 border-slate-200"}`}>
            {t.th.length > 22 ? t.th.slice(0, 22) + "…" : t.th}
            <span className={`ml-1.5 text-xs ${t.key === active ? "text-white/80" : left === 0 ? "text-emerald-600" : "text-amber-600"}`}>{left === 0 ? "ครบ" : `เหลือ ${left}`}</span>
          </button>
        ))}
      </div>
      <div className="card space-y-1">
        <h2 className="font-bold text-slate-800">{tab.th} <span className="font-normal text-slate-500">· {tab.en}</span></h2>
        {tab.tests.map((x) => {
          const v = vals[x.orderId] ?? {};
          const num = (c: string) => { const t = (v[c] ?? "").trim(); if (t === "") return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
          const st = state[x.orderId];
          const real = x.items.filter((i) => !i.computed);
          // computed values and the sentence the doctor reads
          const bmiV = bmi(num("WEIGHT"), num("HEIGHT"));
          const glob = num("TP") != null && num("ALB") != null ? globulin(num("TP")!, num("ALB")!) : null;
          const ibil = num("TBIL") != null && num("DBIL") != null ? indirectBilirubin(num("TBIL")!, num("DBIL")!) : null;
          const ear = (e: "R" | "L") => Object.fromEntries(HEARING_FREQS.map((f) => [f, num(`AUD_${e}_${f}`)]));
          const hearing = x.testCode === "AUDIO" ? interpretHearing(ear("R"), ear("L")) : null;
          const spiro = x.testCode === "SPIRO" ? interpretSpirometry({ age, fvcPct: num("FVC_PCT"), fev1Pct: num("FEV1_PCT"), ratio: num("FEV1FVC_MEAS") }) : null;
          return (
            <div key={x.orderId} className="space-y-1">
              <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
                <span>{x.locked ? "🔒 ตรวจสอบแล้ว แก้ได้ทางฉบับแก้ไขเท่านั้น" : "บันทึกร่างอัตโนมัติ"}</span>
                <span aria-live="polite" className={st?.s === "error" ? "text-rose-600" : ""}>{st?.s === "saving" ? "กำลังบันทึก…" : st?.s === "saved" ? `บันทึกแล้ว ${st.at}` : st?.s === "error" ? st.msg : ""}</span>
              </div>
              {x.items.map((it) => {
                if (it.kind === "file") return (
                  <div key={it.code} className="border-b border-slate-100 py-2 space-y-1">
                    <div className="text-sm font-semibold text-slate-800">{it.en} <span className="font-normal text-xs text-slate-500">— {it.th}</span></div>
                    {x.file ? <a href={x.file.href} target="_blank" rel="noopener" className="text-sm text-brand underline">เปิดไฟล์ที่แนบไว้</a> : <div className="text-xs text-slate-500">ยังไม่ได้แนบไฟล์</div>}
                    {!x.locked && <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="block text-sm min-h-[44px]" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setState((s) => ({ ...s, [x.orderId]: { s: "saving" } })); const r = await upload(x.orderId, f); setState((s) => ({ ...s, [x.orderId]: r.ok ? { s: "saved", at: "แนบไฟล์แล้ว (รีเฟรชเพื่อดูไฟล์)" } : { s: "error", msg: r.message ?? "แนบไฟล์ไม่สำเร็จ" } })); }} />}
                    <div className="text-[11px] text-slate-400">PDF หรือรูปภาพ (JPG, PNG, WEBP) ไม่เกิน 12 MB — แนบได้ทั้งไฟล์จากหน่วยตรวจภายนอก</div>
                  </div>
                );
                const computedVal = it.computed === "bmi" ? bmiV : it.computed === "globulin" ? glob : it.computed === "indirect_bili" ? ibil : null;
                const raw = v[it.code] ?? "";
                const value: number | string | null = it.computed ? computedVal : it.kind === "number" ? num(it.code) : raw === "" ? null : raw;
                const flag = flagResult({ kind: it.kind, refs: it.refs, normal: it.normal ?? undefined }, value, sex, age);
                const crit = typeof value === "number" && !it.computed && isCritical({ code: it.code, refs: it.refs }, value, sex, age, th);
                const odd = typeof value === "number" && !it.computed && it.plausible && implausible({ plausible: it.plausible }, value);
                const ref = refLabel({ refs: it.refs, refText: it.refText ?? undefined });
                return (
                  <div key={it.code} className="grid gap-y-1 sm:grid-cols-[1fr_auto] sm:gap-x-3 items-center border-b border-slate-100 py-2">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-800 break-words">{it.en}</div>
                      <div className="text-xs text-slate-500 break-words">{it.th}{ref ? ` · อ้างอิง ${ref.replace(/\n/g, " / ")}` : ""}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                      {it.computed ? (
                        <span className="min-w-[88px] text-right text-sm tabular-nums">{value != null ? (it.decimals != null ? (value as number).toFixed(it.decimals) : String(value)) : "—"}{it.computed === "bmi" && bmiV != null ? <span className="block text-[11px] text-slate-500">{bmiCategory(bmiV)}</span> : null}</span>
                      ) : it.kind === "choice" ? (
                        <select data-entry disabled={x.locked} className="input min-h-[44px] w-40" value={raw} onKeyDown={nextField} onChange={(e) => change(x.orderId, it.code, e.target.value)}>
                          <option value="">—</option>
                          {it.choices?.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : it.kind === "number" ? (
                        <input data-entry disabled={x.locked} inputMode="decimal" className="input min-h-[44px] w-28 text-right" value={raw}
                          onKeyDown={nextField} aria-label={it.en}
                          onChange={(e) => { const s = e.target.value.replace(",", "."); if (/^-?\d*\.?\d*$/.test(s)) change(x.orderId, it.code, s); }} />
                      ) : (
                        <input data-entry disabled={x.locked} className="input min-h-[44px] w-48" value={raw} onKeyDown={nextField} aria-label={it.en} onChange={(e) => change(x.orderId, it.code, e.target.value)} />
                      )}
                      <span className="w-14 text-xs text-slate-400">{it.unit ?? ""}</span>
                      <span className={`w-20 text-xs ${flag ? FLAG_CLS[flag] : ""}`}>
                        {flag && flag !== "info" ? (flag === "normal" ? "ปกติ" : withArrow(FLAG_TH[flag])) : ""}
                        {crit ? <span className="block text-rose-700 font-bold">⚠ แจ้งแพทย์ทันที</span> : null}
                        {odd ? <span className="block text-amber-700">ตรวจค่าอีกครั้ง</span> : null}
                      </span>
                    </div>
                  </div>
                );
              })}
              {hearing && <div className="rounded-lg bg-amber-50/60 border border-amber-200 px-3 py-2 text-sm"><b>สรุปผลการได้ยิน (ร่างจากระบบ):</b> {hearing}</div>}
              {spiro && spiro.kind !== "incomplete" && <div className="rounded-lg bg-amber-50/60 border border-amber-200 px-3 py-2 text-sm"><b>สรุปผลสมรรถภาพปอด (ร่างจากระบบ):</b> {spiro.th}</div>}
              {real.length === 0 && <p className="text-sm text-slate-500">รายการนี้ไม่มีช่องให้กรอก</p>}
            </div>
          );
        })}
      </div>
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800">ตรวจทานก่อนส่งแพทย์</h2>
        {review.critical.length > 0 && <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800"><b>⚠ ค่าที่ต้องแจ้งแพทย์ทันที:</b> {review.critical.join(" · ")}</div>}
        <div className="text-sm text-slate-700">
          <b>ยังไม่ได้กรอก:</b>{" "}
          {pending.filter((x) => x.left > 0).length === 0 ? <span className="text-emerald-700">ครบทุกหมวด</span> : pending.filter((x) => x.left > 0).map((x) => (
            <button key={x.t.key} type="button" className="mr-2 underline text-amber-700" onClick={() => setActive(x.t.key)}>{x.t.th} ({x.left})</button>
          ))}
        </div>
        <div className="text-sm text-slate-700"><b>ค่านอกเกณฑ์ ({review.flagged.length}):</b> {review.flagged.length ? review.flagged.join(" · ") : "ไม่มี"}</div>
        <p className="text-xs text-slate-500">เมื่อกรอกครบแล้ว กลับไปหน้าผู้เข้ารับการตรวจเพื่อกด "ส่งให้แพทย์"</p>
      </div>
    </div>
  );
}
