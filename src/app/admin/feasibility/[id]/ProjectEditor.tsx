"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { humanizeApiError } from "@/lib/error-messages";
import {
  evaluate, computeScenario, decide,
  type FeasibilityInputs, type Scenario, type PnlResult, type SweetSpot
} from "@/lib/feasibility";
import { FEASIBILITY_COMPANIES } from "@/lib/feasibility-db";

type Meta = {
  company: string; project_name: string;
  location: string; business_type: string; status: string;
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const months = (m: number) => (Number.isFinite(m) ? `${m.toFixed(2)} เดือน` : "—");
const baht = (v: number) => `฿${fmtMoney(v)}`;

const VERDICT_CLS: Record<"go" | "caution" | "no", string> = {
  go: "bg-emerald-50 border-emerald-300 text-emerald-800",
  caution: "bg-amber-50 border-amber-300 text-amber-900",
  no: "bg-rose-50 border-rose-300 text-rose-800"
};
const CHIP_CLS: Record<"go" | "caution" | "no", string> = {
  go: "bg-emerald-100 text-emerald-800",
  caution: "bg-amber-100 text-amber-800",
  no: "bg-rose-100 text-rose-700"
};

// ── small inputs ─────────────────────────────────────────────────
function NumField({ label, value, onChange, suffix }: {
  label: string; value: number; onChange: (v: number) => void; suffix?: string;
}) {
  return (
    <div>
      <label className="label !text-xs !mb-0.5">{label}</label>
      <div className="relative">
        <input
          className="input !py-1.5 text-sm"
          type="number" inputMode="decimal"
          value={value === 0 ? "" : value}
          placeholder="0"
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} />
        {suffix && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

function Section({ title, defaultOpen = true, footer, children }: {
  title: string; defaultOpen?: boolean; footer?: React.ReactNode; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2">
        <h3 className="font-bold text-slate-800 text-sm">{title}</h3>
        <span className="text-slate-400 text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
      {open && footer && <div className="mt-3 pt-2 border-t border-slate-100">{footer}</div>}
    </div>
  );
}

export default function ProjectEditor({ id, meta: meta0, inputs: inputs0 }: {
  id: number; meta: Meta; inputs: FeasibilityInputs;
}) {
  const router = useRouter();
  const [meta, setMeta] = useState<Meta>(meta0);
  const [inputs, setInputs] = useState<FeasibilityInputs>(inputs0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const result = useMemo(() => evaluate(inputs), [inputs]);

  // nested setters
  const mset = <K extends keyof Meta>(k: K, v: Meta[K]) => setMeta((p) => ({ ...p, [k]: v }));
  const setA = (k: keyof FeasibilityInputs["assumptions"], v: number) =>
    setInputs((p) => ({ ...p, assumptions: { ...p.assumptions, [k]: v } }));
  const setTriple = (
    k: "turnoverWeekday" | "turnoverWeekend" | "deliveryWeekday" | "deliveryWeekend",
    sc: Scenario, v: number
  ) => setInputs((p) => ({
    ...p, assumptions: { ...p.assumptions, [k]: { ...p.assumptions[k], [sc]: v } }
  }));
  const setS = (k: keyof FeasibilityInputs["startup"], v: number) =>
    setInputs((p) => ({ ...p, startup: { ...p.startup, [k]: v } }));
  const setV = (k: keyof FeasibilityInputs["variablePct"], v: number) =>
    setInputs((p) => ({ ...p, variablePct: { ...p.variablePct, [k]: v } }));
  const setF = (k: keyof FeasibilityInputs["fixed"], v: number) =>
    setInputs((p) => ({ ...p, fixed: { ...p.fixed, [k]: v } }));
  const setT = (k: keyof FeasibilityInputs["thresholds"], v: number) =>
    setInputs((p) => ({ ...p, thresholds: { ...p.thresholds, [k]: v } }));

  async function save() {
    setBusy(true); setMsg(null);
    if (!meta.project_name.trim()) { setMsg({ kind: "err", text: "กรุณาตั้งชื่อโปรเจค" }); setBusy(false); return; }
    try {
      const res = await fetch(apiUrl(`/api/feasibility/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: meta.company,
          project_name: meta.project_name,
          location: meta.location || null,
          business_type: meta.business_type || null,
          status: meta.status,
          inputs
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setMsg({ kind: "err", text: humanizeApiError(j, "บันทึกไม่สำเร็จ") }); return; }
      setMsg({ kind: "ok", text: "บันทึกแล้ว" });
      router.refresh();
    } finally { setBusy(false); }
  }

  async function copySummary() {
    setMsg(null);
    const text = buildSummary(meta, inputs);
    try {
      await navigator.clipboard.writeText(text);
      setMsg({ kind: "ok", text: "คัดลอกสรุปแล้ว — วางส่งทาง LINE/อีเมลได้เลย" });
    } catch {
      setMsg({ kind: "err", text: "คัดลอกไม่สำเร็จ (เบราว์เซอร์ไม่รองรับ)" });
    }
  }

  const a = inputs.assumptions;
  const tripleRow = (
    label: string,
    k: "turnoverWeekday" | "turnoverWeekend" | "deliveryWeekday" | "deliveryWeekend"
  ) => (
    <div className="grid grid-cols-4 gap-2 items-end">
      <div className="text-xs text-slate-500 pb-2">{label}</div>
      {(["base", "best", "worst"] as Scenario[]).map((sc) => (
        <NumField key={sc}
          label={sc === "base" ? "ฐาน" : sc === "best" ? "ดีสุด" : "แย่สุด"}
          value={a[k][sc]} onChange={(v) => setTriple(k, sc, v)} />
      ))}
    </div>
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
      {/* ── LEFT: inputs ─────────────────────────────────────── */}
      <div className="space-y-3">
        <Section title="ข้อมูลโปรเจค">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="label !text-xs">ชื่อโปรเจค *</label>
              <input className="input" value={meta.project_name}
                onChange={(e) => mset("project_name", e.target.value)} />
            </div>
            <div>
              <label className="label !text-xs">บริษัท</label>
              <select className="input" value={meta.company} onChange={(e) => mset("company", e.target.value)}>
                {FEASIBILITY_COMPANIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="label !text-xs">สถานะ</label>
              <select className="input" value={meta.status} onChange={(e) => mset("status", e.target.value)}>
                <option value="draft">ร่าง</option>
                <option value="active">ใช้งาน</option>
                <option value="archived">เก็บถาวร</option>
              </select>
            </div>
            <div>
              <label className="label !text-xs">ทำเล</label>
              <input className="input" value={meta.location} onChange={(e) => mset("location", e.target.value)} />
            </div>
            <div>
              <label className="label !text-xs">ประเภทธุรกิจ</label>
              <input className="input" value={meta.business_type} onChange={(e) => mset("business_type", e.target.value)} />
            </div>
          </div>
        </Section>

        <Section title="สมมติฐานรายได้">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <NumField label="ที่นั่ง" value={a.seats} onChange={(v) => setA("seats", v)} />
            <NumField label="อัตราเข้าร้าน" value={a.occupancyPct} onChange={(v) => setA("occupancyPct", v)} suffix="%" />
            <NumField label="วันธรรมดา/เดือน" value={a.weekdayDays} onChange={(v) => setA("weekdayDays", v)} />
            <NumField label="วันหยุด/เดือน" value={a.weekendDays} onChange={(v) => setA("weekendDays", v)} />
            <NumField label="บิลเฉลี่ย (นั่งทาน)" value={a.avgCheckSitin} onChange={(v) => setA("avgCheckSitin", v)} suffix="฿" />
            <NumField label="ต้นทุนอาหาร (นั่ง)" value={a.cogsSitinPct} onChange={(v) => setA("cogsSitinPct", v)} suffix="%" />
            <NumField label="บิลเฉลี่ย (เดลิเวอรี)" value={a.avgCheckDelivery} onChange={(v) => setA("avgCheckDelivery", v)} suffix="฿" />
            <NumField label="ต้นทุนอาหาร (เดลิ)" value={a.cogsDeliveryPct} onChange={(v) => setA("cogsDeliveryPct", v)} suffix="%" />
          </div>
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold text-slate-500">รอบโต๊ะ/วัน (ครั้ง)</div>
            {tripleRow("วันธรรมดา", "turnoverWeekday")}
            {tripleRow("วันหยุด", "turnoverWeekend")}
            <div className="text-[11px] font-semibold text-slate-500 pt-1">ออเดอร์เดลิเวอรี/วัน</div>
            {tripleRow("วันธรรมดา", "deliveryWeekday")}
            {tripleRow("วันหยุด", "deliveryWeekend")}
          </div>
        </Section>

        <Section title="เงินลงทุนตั้งต้น" footer={
          <div className="flex justify-between text-sm font-bold">
            <span className="text-slate-600">รวมเงินลงทุน</span>
            <span className="text-slate-900">{baht(result.startupTotal)}</span>
          </div>
        }>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="ก่อสร้าง/ตกแต่ง" value={inputs.startup.construction} onChange={(v) => setS("construction", v)} suffix="฿" />
            <NumField label="เฟอร์นิเจอร์/อุปกรณ์" value={inputs.startup.ffe} onChange={(v) => setS("ffe", v)} suffix="฿" />
            <NumField label="สต๊อกเริ่มต้น" value={inputs.startup.stock} onChange={(v) => setS("stock", v)} suffix="฿" />
            <NumField label="ฮาร์ดแวร์อื่นๆ" value={inputs.startup.hardOther} onChange={(v) => setS("hardOther", v)} suffix="฿" />
            <NumField label="ค่าแฟรนไชส์" value={inputs.startup.franchise} onChange={(v) => setS("franchise", v)} suffix="฿" />
            <NumField label="เงินมัดจำ" value={inputs.startup.deposit} onChange={(v) => setS("deposit", v)} suffix="฿" />
            <NumField label="ใบอนุญาต" value={inputs.startup.permit} onChange={(v) => setS("permit", v)} suffix="฿" />
            <NumField label="ค่าวิชาชีพ" value={inputs.startup.professional} onChange={(v) => setS("professional", v)} suffix="฿" />
            <NumField label="ก่อนเปิดร้าน" value={inputs.startup.preOpening} onChange={(v) => setS("preOpening", v)} suffix="฿" />
            <NumField label="อื่นๆ (soft)" value={inputs.startup.softOther} onChange={(v) => setS("softOther", v)} suffix="฿" />
          </div>
        </Section>

        <Section title="ต้นทุนผันแปร (% ของยอดขาย)" defaultOpen={false}>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Royalty" value={inputs.variablePct.royalty} onChange={(v) => setV("royalty", v)} suffix="%" />
            <NumField label="Service charge" value={inputs.variablePct.service} onChange={(v) => setV("service", v)} suffix="%" />
            <NumField label="ค่าบริหาร" value={inputs.variablePct.mgmt} onChange={(v) => setV("mgmt", v)} suffix="%" />
            <NumField label="การตลาด" value={inputs.variablePct.marketing} onChange={(v) => setV("marketing", v)} suffix="%" />
            <NumField label="ซ่อมบำรุง" value={inputs.variablePct.repair} onChange={(v) => setV("repair", v)} suffix="%" />
            <NumField label="สำรองเผื่อ" value={inputs.variablePct.contingency} onChange={(v) => setV("contingency", v)} suffix="%" />
            <NumField label="GP เดลิเวอรี" value={inputs.variablePct.gpDelivery} onChange={(v) => setV("gpDelivery", v)} suffix="%" />
            <NumField label="พาร์ทไทม์ (คงที่)" value={inputs.variablePct.partTimeFixed} onChange={(v) => setV("partTimeFixed", v)} suffix="฿" />
          </div>
        </Section>

        <Section title="ต้นทุนคงที่ (ต่อเดือน)" defaultOpen={false} footer={
          <div className="flex justify-between text-xs text-slate-500">
            <span>เบี้ยประกัน All Risks (คำนวณอัตโนมัติ)</span>
            <span className="font-semibold">{baht(result.insurance)}</span>
          </div>
        }>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="ค่าเช่า" value={inputs.fixed.rent} onChange={(v) => setF("rent", v)} suffix="฿" />
            <NumField label="เงินเดือนพนักงาน" value={inputs.fixed.staff} onChange={(v) => setF("staff", v)} suffix="฿" />
            <NumField label="ล้างจาน" value={inputs.fixed.dishwash} onChange={(v) => setF("dishwash", v)} suffix="฿" />
            <NumField label="สาธารณูปโภค" value={inputs.fixed.utilities} onChange={(v) => setF("utilities", v)} suffix="฿" />
            <NumField label="โทรศัพท์/เน็ต" value={inputs.fixed.telephone} onChange={(v) => setF("telephone", v)} suffix="฿" />
            <NumField label="POS" value={inputs.fixed.pos} onChange={(v) => setF("pos", v)} suffix="฿" />
            <NumField label="ค่างวดเงินกู้" value={inputs.fixed.loan} onChange={(v) => setF("loan", v)} suffix="฿" />
            <NumField label="ภาษีโรงเรือน (% ค่าเช่า)" value={inputs.fixed.propertyTaxPct} onChange={(v) => setF("propertyTaxPct", v)} suffix="%" />
          </div>
        </Section>

        <Section title="เกณฑ์ตัดสินใจ" defaultOpen={false}>
          <div className="grid grid-cols-3 gap-2">
            <NumField label="คืนทุนภายใน" value={inputs.thresholds.paybackMonths} onChange={(v) => setT("paybackMonths", v)} suffix="เดือน" />
            <NumField label="ROI ต่อปี ≥" value={inputs.thresholds.roiPct} onChange={(v) => setT("roiPct", v)} suffix="%" />
            <NumField label="MoS ≥" value={inputs.thresholds.mosPct} onChange={(v) => setT("mosPct", v)} suffix="%" />
          </div>
        </Section>
      </div>

      {/* ── RIGHT: live results ──────────────────────────────── */}
      <div className="space-y-3 lg:sticky lg:top-4">
        <div className={`card border-2 ${VERDICT_CLS[result.decision.verdict]}`}>
          <div className="text-xs opacity-70">ผลการประเมิน (อิงสถานการณ์ฐาน)</div>
          <div className="text-2xl font-bold mt-0.5">{result.decision.label}</div>
          {result.decision.reasons.length > 0 && (
            <ul className="mt-1 text-xs list-disc list-inside opacity-90">
              {result.decision.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
            {[
              { k: "กำไร/เดือน", v: baht(result.base.profit) },
              { k: "คืนทุน", v: months(result.base.paybackMonths) },
              { k: "ROI/ปี", v: pct(result.base.roiAnnual) },
              { k: "Margin of Safety", v: pct(result.base.marginOfSafety) }
            ].map((x) => (
              <div key={x.k} className="bg-white/60 rounded-lg px-2 py-1.5">
                <div className="text-[10px] opacity-70">{x.k}</div>
                <div className="font-bold text-sm tabular-nums">{x.v}</div>
              </div>
            ))}
          </div>
        </div>

        <SweetSpotGauge sweet={result.sweet} />
        <ScenarioTable inputs={inputs} />
        <SensitivityTable inputs={inputs} />

        <div className="card flex flex-wrap items-center justify-between gap-2">
          {msg && (
            <span className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
              {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
            </span>
          )}
          <div className="flex items-center gap-2 ml-auto">
            <button type="button" onClick={copySummary} disabled={busy}
              className="btn-secondary disabled:opacity-50">คัดลอกสรุปผล</button>
            <button type="button" onClick={save} disabled={busy}
              className="btn-primary disabled:opacity-50">
              {busy ? "กำลังบันทึก…" : "บันทึกโปรเจค"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 3-scenario comparison table ──────────────────────────────────
function ScenarioTable({ inputs }: { inputs: FeasibilityInputs }) {
  const cols: { sc: Scenario; label: string }[] = [
    { sc: "base", label: "ฐาน" }, { sc: "best", label: "ดีสุด" }, { sc: "worst", label: "แย่สุด" }
  ];
  const rs = cols.map((c) => computeScenario(inputs, c.sc));
  const row = (label: string, fn: (r: PnlResult) => string) => (
    <tr className="border-t border-slate-100">
      <td className="py-1.5 pr-2 text-slate-500">{label}</td>
      {rs.map((r, i) => <td key={i} className="py-1.5 px-1 text-right tabular-nums">{fn(r)}</td>)}
    </tr>
  );
  return (
    <div className="card overflow-x-auto">
      <h3 className="font-bold text-slate-800 text-sm mb-2">เทียบ 3 สถานการณ์</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-400">
            <th className="text-left font-medium pb-1">รายการ</th>
            {cols.map((c) => <th key={c.sc} className="text-right font-medium pb-1 px-1">{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {row("ยอดขาย", (r) => baht(r.sales))}
          {row("ต้นทุนอาหาร", (r) => baht(r.cogs))}
          {row("กำไรขั้นต้น", (r) => baht(r.grossProfit))}
          {row("ต้นทุนผันแปร", (r) => baht(r.variable))}
          {row("ต้นทุนคงที่", (r) => baht(r.fixed))}
          {row("กำไรสุทธิ", (r) => baht(r.profit))}
          {row("คืนทุน", (r) => months(r.paybackMonths))}
          {row("ROI/ปี", (r) => pct(r.roiAnnual))}
          {row("จุดคุ้มทุน (หัว/วัน)", (r) => Number.isFinite(r.breakevenPerDay) ? r.breakevenPerDay.toFixed(1) : "—")}
          {row("Margin of Safety", (r) => pct(r.marginOfSafety))}
          <tr className="border-t border-slate-200">
            <td className="py-1.5 pr-2 text-slate-500">คำตัดสิน</td>
            {rs.map((r, i) => {
              const d = decide(r, inputs.thresholds);
              return (
                <td key={i} className="py-1.5 px-1 text-right">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${CHIP_CLS[d.verdict]}`}>
                    {d.verdict === "go" ? "น่าลงทุน" : d.verdict === "caution" ? "เสี่ยง" : "ไม่ควร"}
                  </span>
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── revenue sweet-spot gauge (signature view) ────────────────────
function SweetSpotGauge({ sweet }: { sweet: SweetSpot }) {
  const marks = [
    { key: "floor", label: "ขั้นต่ำ", note: "ไม่ขาดทุน", v: sweet.floor, color: "bg-rose-500" },
    { key: "target", label: "เป้าหมาย", note: "คืนทุนตามเป้า", v: sweet.target, color: "bg-amber-500" },
    { key: "comfort", label: "หลัก", note: "สมมติฐานหลัก", v: sweet.comfort, color: "bg-blue-600" },
    { key: "ceiling", label: "เพดาน", note: "ศักยภาพสูงสุด", v: sweet.ceiling, color: "bg-emerald-600" }
  ].filter((m) => Number.isFinite(m.v) && m.v >= 0);
  if (marks.length < 2) {
    return (
      <div className="card">
        <h3 className="font-bold text-slate-800 text-sm">ช่วงรายได้ที่เหมาะสม</h3>
        <p className="text-xs text-slate-400 mt-1">กรอกสมมติฐานรายได้ให้ครบเพื่อดูช่วงรายได้</p>
      </div>
    );
  }
  const vals = marks.map((m) => m.v);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const posOf = (v: number) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
  return (
    <div className="card">
      <h3 className="font-bold text-slate-800 text-sm mb-3">ช่วงรายได้ที่เหมาะสม (ต่อเดือน)</h3>
      <div className="relative h-2 rounded-full bg-gradient-to-r from-rose-200 via-amber-200 to-emerald-200">
        {marks.map((m) => (
          <div key={m.key} className="absolute -top-1 -translate-x-1/2" style={{ left: `${posOf(m.v)}%` }}>
            <div className={`w-3 h-3 rounded-full ${m.color} ring-2 ring-white`} />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
        {marks.map((m) => (
          <div key={m.key} className="text-center">
            <div className={`inline-block w-2 h-2 rounded-full ${m.color}`} />
            <div className="text-[11px] font-semibold text-slate-700">{m.label}</div>
            <div className="text-xs font-bold tabular-nums">{baht(m.v)}</div>
            <div className="text-[10px] text-slate-400">~{sweet.dailyHeads(m.v).toFixed(0)} หัว/วัน</div>
            <div className="text-[9px] text-slate-400">{m.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── occupancy sensitivity (Base turns) ───────────────────────────
function SensitivityTable({ inputs }: { inputs: FeasibilityInputs }) {
  const levels = [50, 60, 70, 75, 80, 90];
  const cur = inputs.assumptions.occupancyPct;
  const rows = levels.map((occ) => {
    const r = computeScenario(
      { ...inputs, assumptions: { ...inputs.assumptions, occupancyPct: occ } }, "base"
    );
    return { occ, sales: r.sales, profit: r.profit, payback: r.paybackMonths };
  });
  return (
    <div className="card overflow-x-auto">
      <h3 className="font-bold text-slate-800 text-sm mb-2">ความไวต่ออัตราเข้าร้าน (สถานการณ์ฐาน)</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-400">
            <th className="text-left font-medium pb-1">อัตราเข้าร้าน</th>
            <th className="text-right font-medium pb-1 px-1">ยอดขาย</th>
            <th className="text-right font-medium pb-1 px-1">กำไร</th>
            <th className="text-right font-medium pb-1 px-1">คืนทุน</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const active = Math.abs(r.occ - cur) < 0.5;
            return (
              <tr key={r.occ} className={`border-t border-slate-100 ${active ? "bg-brand/10 font-semibold" : ""}`}>
                <td className="py-1.5 pr-2">{r.occ}%{active ? " ← ปัจจุบัน" : ""}</td>
                <td className="py-1.5 px-1 text-right tabular-nums">{baht(r.sales)}</td>
                <td className={`py-1.5 px-1 text-right tabular-nums ${r.profit > 0 ? "" : "text-rose-600"}`}>{baht(r.profit)}</td>
                <td className="py-1.5 px-1 text-right tabular-nums">{months(r.payback)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── copy-to-clipboard summary text ───────────────────────────────
function buildSummary(meta: Meta, inputs: FeasibilityInputs): string {
  const r = evaluate(inputs);
  const s = r.sweet;
  const L: string[] = [];
  L.push(`FEASIBILITY — ${meta.project_name} (${meta.company})`);
  if (meta.location) L.push(`ทำเล: ${meta.location}`);
  L.push("");
  L.push(`ผลการประเมิน: ${r.decision.label}`);
  if (r.decision.reasons.length) L.push(`เหตุผล: ${r.decision.reasons.join(", ")}`);
  L.push("");
  L.push(`กำไร/เดือน: ${baht(r.base.profit)}`);
  L.push(`คืนทุน: ${months(r.base.paybackMonths)}`);
  L.push(`ROI/ปี: ${pct(r.base.roiAnnual)}`);
  L.push(`Margin of Safety: ${pct(r.base.marginOfSafety)}`);
  L.push(`เงินลงทุนรวม: ${baht(r.startupTotal)}`);
  L.push("");
  L.push("ช่วงรายได้/เดือน:");
  L.push(`  ขั้นต่ำ ${baht(s.floor)} · เป้าหมาย ${baht(s.target)} · หลัก ${baht(s.comfort)} · เพดาน ${baht(s.ceiling)}`);
  return L.join("\n");
}
