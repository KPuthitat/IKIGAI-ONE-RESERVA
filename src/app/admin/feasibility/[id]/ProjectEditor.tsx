"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { humanizeApiError } from "@/lib/error-messages";
import {
  evaluate, computeScenario, decide,
  type FeasibilityInputs, type Scenario, type PnlResult
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

        <ScenarioTable inputs={inputs} />

        <div className="card flex items-center justify-between gap-2">
          {msg && (
            <span className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
              {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
            </span>
          )}
          <button type="button" onClick={save} disabled={busy}
            className="btn-primary ml-auto disabled:opacity-50">
            {busy ? "กำลังบันทึก…" : "บันทึกโปรเจค"}
          </button>
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
