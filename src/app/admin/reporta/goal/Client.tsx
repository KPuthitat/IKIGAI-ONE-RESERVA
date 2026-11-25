"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { CostRatios } from "@/lib/cost-guardrails";
import CostSection from "./CostSection";

type Digest = { weekFrom: string; weekTo: string; month: string; branches: Array<{ label: string; weekSales: number; prevWeekSales: number; mtd: number; target: number | null; pctOfTarget: number | null; forecast: number | null; forecastPct: number | null; pacePct: number | null }>; total: { weekSales: number; mtd: number; target: number | null; forecast: number | null } };
type Props = {
  costs: Array<{ label: string; r: CostRatios }>;
  unmatched: string[]; year: number; groups: number; weeklyEnabled: boolean; monday: string; digest: Digest;
  targets: Array<{ name: string; label: string; annual: number; provisional: number[]; current: Array<number | null> }>;
  backtest: Array<{ label: string; doc: number; grossLessDiscount: number; nett: number; nettLessVatSc: number; gross: number; days: number }>;
};
const n = (x: number) => Math.round(x).toLocaleString("en-US");
const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

export default function Client(p: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function post(body: Record<string, unknown>, ok: (j: Record<string, unknown>) => string) {
    setBusy(true); setMsg(null);
    const r = await fetch(apiUrl("/api/admin/reporta/goal"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: (j.message as string) ?? "ทำรายการไม่สำเร็จ" }); return; }
    setMsg({ ok: true, text: ok(j) }); router.refresh();
  }
  const anySet = p.targets.some((t) => t.current.some((c) => c != null));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">เป้าหมายองค์กร {p.year}</h1>
        <p className="text-sm text-slate-500 mt-1">ระยะ 1: เป้ายอดขายรายเดือนต่อสาขา และสรุปยอดขายเทียบเป้าทุกวันจันทร์เข้ากลุ่มผู้บริหาร (ตัวเลขทั้งหมดมาจากระบบ ไม่ใช่ AI)</p>
      </div>
      {msg && <div className={`card text-sm ${msg.ok ? "text-emerald-800 bg-emerald-50 border-emerald-200" : "text-rose-800 bg-rose-50 border-rose-200"}`} role="status">{msg.text}</div>}
      {p.unmatched.length > 0 && <div className="card text-sm text-amber-800 bg-amber-50 border-amber-200">ไม่พบสาขาที่ชื่อตรงกับ: {p.unmatched.join(", ")} จึงยังไม่มีเป้าของสาขานั้น</div>}

      <section className="card space-y-3">
        <h2 className="font-bold text-slate-800">1. ทดสอบนิยามยอดขายกับปี 2026</h2>
        <p className="text-xs text-slate-500">เอกสารใช้ “ยอดก่อน VAT และก่อน Service charge (Gross − ส่วนลด)” ตารางนี้เทียบยอดจากระบบ (Feedme) กับ baseline ในเอกสาร ถ้านิยามไหนใกล้ตัวเลขเอกสารที่สุดคือนิยามที่ควรใช้ (ตอนนี้สรุปรายสัปดาห์ใช้ Gross − ส่วนลด)</p>
        <div className="overflow-x-auto"><table className="w-full text-sm tabular-nums">
          <thead><tr className="text-[11px] text-slate-500 border-b border-slate-100"><th className="text-left py-1.5">ช่วง</th><th className="text-right px-2">เอกสาร</th><th className="text-right px-2">Gross − ส่วนลด</th><th className="text-right px-2">Nett − VAT − SC</th><th className="text-right px-2">Nett</th><th className="text-right pl-2">วันที่มีข้อมูล</th></tr></thead>
          <tbody>{p.backtest.map((b) => (
            <tr key={b.label} className="border-b border-slate-50"><td className="py-2">{b.label}</td><td className="text-right px-2">{n(b.doc)}</td>
              {[b.grossLessDiscount, b.nettLessVatSc, b.nett].map((v, i) => <td key={i} className="text-right px-2">{n(v)} <span className={`text-xs ${Math.abs(v / b.doc - 1) <= 0.03 ? "text-emerald-600" : "text-slate-400"}`}>({v > 0 ? `${Math.round((v / b.doc - 1) * 100)}%` : "-"})</span></td>)}
              <td className="text-right pl-2">{b.days}</td></tr>))}</tbody>
        </table></div>
      </section>

      <section className="card space-y-3">
        <h2 className="font-bold text-slate-800">2. เป้ายอดขายรายเดือน {p.year}</h2>
        <p className="text-xs text-slate-500">เป้าชั่วคราว = เป้าทั้งปีตามเอกสาร (Nama 7.4M, Hypo 9.8M) แบ่งตามจำนวนวันที่เปิด จนกว่าหัวข้อ 2 และดัชนีฤดูกาลจะมา แล้วค่อยแก้เป็นรายเดือนจริงที่ ANALYTICA</p>
        {p.targets.map((t) => (
          <div key={t.name} className="overflow-x-auto">
            <div className="text-sm font-bold text-slate-700 mb-1">{t.name} <span className="font-normal text-slate-400">· เป้าทั้งปี {n(t.annual)}</span></div>
            <table className="w-full text-xs tabular-nums"><thead><tr className="text-slate-500">{MONTHS.map((m) => <th key={m} className="text-right px-1 font-medium">{m}</th>)}</tr></thead>
              <tbody><tr className="text-slate-800">{t.current.map((c, i) => <td key={i} className="text-right px-1 py-1">{c == null ? <span className="text-slate-300">—</span> : n(c / 1000) + "K"}</td>)}</tr>
                <tr className="text-slate-400">{t.provisional.map((c, i) => <td key={i} className="text-right px-1">{n(c / 1000)}K</td>)}</tr></tbody></table>
            <div className="text-[11px] text-slate-400">แถวบน = เป้าที่ตั้งไว้ในระบบ · แถวล่าง = เป้าชั่วคราวตามเอกสาร</div>
          </div>
        ))}
        <div className="flex gap-2 flex-wrap">
          <button type="button" className="btn-primary" disabled={busy || p.targets.length === 0} onClick={() => window.confirm(anySet ? "ใส่เป้าชั่วคราวเฉพาะเดือนที่ยังไม่มีเป้า (ไม่ทับของเดิม) ใช่หรือไม่" : "ใส่เป้าชั่วคราวตามเอกสารให้ทุกเดือนใช่หรือไม่") && post({ action: "seed_targets", overwrite: false }, (j) => `ตั้งเป้าแล้ว: ${(j.result as Array<{ branch: string; months: number }>).map((r) => `${r.branch} ${r.months} เดือน`).join(", ")}`)}>ใส่เป้าชั่วคราวตามเอกสาร (เดือนที่ยังว่าง)</button>
          {anySet && <button type="button" className="btn-secondary" disabled={busy} onClick={() => window.confirm("เขียนทับเป้าทุกเดือนของปีนี้ด้วยเป้าชั่วคราว ใช่หรือไม่ (เป้าที่แก้ไว้จะหายไป)") && post({ action: "seed_targets", overwrite: true }, () => "เขียนทับเป้าด้วยค่าชั่วคราวแล้ว")}>เขียนทับทุกเดือน</button>}
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="font-bold text-slate-800">3. สรุปรายสัปดาห์เข้ากลุ่มผู้บริหาร</h2>
        <p className="text-xs text-slate-500">ส่งทุกวันจันทร์ตั้งแต่ 08:00 (สัปดาห์จันทร์–อาทิตย์ที่ผ่านมา + สะสมเดือนนี้เทียบเป้า + คาดสิ้นเดือน) ไปยังกลุ่มที่เจ้าของเปิดใช้นกฮูกไว้ · ตอนนี้มี {p.groups} กลุ่ม</p>
        <div className="rounded-xl border border-slate-200 p-3 text-sm space-y-1">
          <div className="font-bold text-slate-700">ตัวอย่าง (สัปดาห์ {p.digest.weekFrom} ถึง {p.digest.weekTo})</div>
          {p.digest.branches.length === 0 ? <p className="text-slate-500">ยังไม่พบสาขาเป้าหมาย</p> : p.digest.branches.map((b) => (
            <div key={b.label} className="text-slate-700"><b>{b.label}</b> สัปดาห์ {n(b.weekSales)} · สะสม {n(b.mtd)}{b.target ? ` / เป้า ${n(b.target)} (${b.pctOfTarget}%) · คาดสิ้นเดือน ${b.forecast == null ? "-" : n(b.forecast)} (${b.forecastPct}%)` : " · ยังไม่ได้ตั้งเป้าเดือนนี้"}</div>))}
          <div className="text-slate-500">รวมสัปดาห์ {n(p.digest.total.weekSales)}</div>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <button type="button" className="btn-secondary" disabled={busy || p.groups === 0} onClick={() => window.confirm("ส่งสรุปนี้เข้ากลุ่มผู้บริหารตอนนี้ใช่หรือไม่") && post({ action: "send_now", monday: p.monday }, (j) => `ส่งเข้า ${j.sent} กลุ่มแล้ว`)}>ส่งสรุปเข้ากลุ่มตอนนี้</button>
          <button type="button" className={p.weeklyEnabled ? "btn-secondary" : "btn-primary"} disabled={busy} onClick={() => post({ action: "set_weekly", enabled: !p.weeklyEnabled }, (j) => j.enabled ? "เปิดสรุปอัตโนมัติทุกวันจันทร์แล้ว" : "ปิดสรุปอัตโนมัติแล้ว")}>{p.weeklyEnabled ? "ปิดสรุปอัตโนมัติทุกวันจันทร์" : "เปิดสรุปอัตโนมัติทุกวันจันทร์"}</button>
          <span className={`tag ${p.weeklyEnabled ? "tag-ok" : "tag-mute"}`}>{p.weeklyEnabled ? "เปิดอยู่" : "ปิดอยู่"}</span>
        </div>
        {p.groups === 0 && <p className="text-xs text-amber-700">ยังไม่มีกลุ่มผู้บริหารที่เปิดใช้นกฮูก พิมพ์ “@นกฮูก เปิดใช้กลุ่มนี้” ในกลุ่มก่อน</p>}
      </section>
      <CostSection items={p.costs} busy={busy} onSave={(code, min, max) => post({ action: "set_band", code, min, max }, () => "บันทึกช่วงเกณฑ์แล้ว")} />
    </div>
  );
}
