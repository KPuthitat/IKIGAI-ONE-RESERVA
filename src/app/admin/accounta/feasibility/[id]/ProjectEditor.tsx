"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { humanizeApiError } from "@/lib/error-messages";
import {
  evaluate, computeScenario, decide,
  STARTUP_CATEGORIES, whtBaht,
  type FeasibilityInputs, type Scenario, type PnlResult, type SweetSpot
} from "@/lib/feasibility";
import { useConfirm } from "@/app/components/useConfirm";

type Meta = {
  company: string; project_name: string;
  location: string; business_type: string; status: string;
};

export type StartupItem = {
  id: number;
  category: string;
  paid_date: string | null;
  item_name: string;
  payee: string | null;
  amount: number;
  wht_mode: string;
  wht_value: number;
  doc_type: string | null;
  payment_status: string;
};

const STARTUP_LABELS: Record<string, string> = {
  construction: "ก่อสร้าง/ตกแต่ง", ffe: "เฟอร์นิเจอร์/อุปกรณ์", stock: "สต๊อกเริ่มต้น",
  hardOther: "ฮาร์ดแวร์อื่นๆ", franchise: "ค่าแฟรนไชส์", deposit: "เงินมัดจำ",
  permit: "ใบอนุญาต", professional: "ค่าวิชาชีพ", preOpening: "ก่อนเปิดร้าน", softOther: "อื่นๆ (soft)"
};
const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

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

export default function ProjectEditor({ id, meta: meta0, inputs: inputs0, startupItems: items0, companies }: {
  id: number; meta: Meta; inputs: FeasibilityInputs; startupItems: StartupItem[]; companies: string[];
}) {
  const router = useRouter();
  const [meta, setMeta] = useState<Meta>(meta0);
  const [inputs, setInputs] = useState<FeasibilityInputs>(inputs0);
  const [items, setItems] = useState<StartupItem[]>(items0);
  const [startupModalCat, setStartupModalCat] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Keep inputs.startup.<category> = sum of that category's items (mirrors the
  // server's syncCategory) so the live KPIs reflect the ledger immediately.
  useEffect(() => {
    setInputs((prev) => {
      const startup = { ...prev.startup };
      let changed = false;
      for (const cat of STARTUP_CATEGORIES) {
        const k = cat as keyof typeof startup;
        const catItems = items.filter((i) => i.category === cat);
        if (catItems.length > 0) {
          const sum = round2(catItems.reduce((s, i) => s + i.amount, 0));
          if (startup[k] !== sum) { startup[k] = sum; changed = true; }
        }
      }
      return changed ? { ...prev, startup } : prev;
    });
  }, [items]);

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
                {[...new Set([meta.company, ...companies].filter(Boolean))].map((c) => <option key={c} value={c}>{c}</option>)}
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
            <div className="sm:col-span-2">
              <label className="label !text-xs">ทำเล (ที่อยู่ / พิกัด หรือลิงก์ Google Maps)</label>
              <input className="input" value={meta.location}
                onChange={(e) => mset("location", e.target.value)}
                placeholder="เช่น 13.61,100.92 · ชื่อสถานที่ · หรือวางลิงก์ Google Maps" />
              {meta.location.trim() && (
                <div className="mt-2 rounded-lg overflow-hidden border border-slate-200">
                  <iframe title="แผนที่ทำเล" className="w-full h-44 block"
                    loading="lazy"
                    src={`https://maps.google.com/maps?q=${encodeURIComponent(meta.location.trim())}&output=embed`} />
                </div>
              )}
            </div>
            <div className="sm:col-span-2">
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
          <div className="space-y-1.5">
            <p className="text-[11px] text-slate-400">
              กดหัวข้อเพื่อเพิ่มรายการจ่ายจริง (วันที่ · ผู้รับเงิน · เอกสาร · สถานะ) — ยอดรวมจะคำนวณอัตโนมัติ
            </p>
            {STARTUP_CATEGORIES.map((cat) => {
              const k = cat as keyof FeasibilityInputs["startup"];
              const catItems = items.filter((i) => i.category === cat);
              const sum = round2(catItems.reduce((s, i) => s + i.amount, 0));
              return (
                <div key={cat} className="flex items-center gap-2">
                  <div className="flex-1 text-sm text-slate-600 min-w-0 truncate">{STARTUP_LABELS[cat]}</div>
                  {catItems.length > 0 ? (
                    <div className="w-28 text-right text-sm font-semibold tabular-nums">{baht(sum)}</div>
                  ) : (
                    <input className="input !py-1 text-sm !w-28 text-right" type="number" inputMode="decimal"
                      value={inputs.startup[k] === 0 ? "" : inputs.startup[k]} placeholder="0"
                      onChange={(e) => setS(k, e.target.value === "" ? 0 : Number(e.target.value))} />
                  )}
                  <button type="button" onClick={() => setStartupModalCat(cat)}
                    className="text-xs text-brand hover:underline whitespace-nowrap w-24 text-right">
                    {catItems.length > 0 ? `จัดการ (${catItems.length})` : "+ เพิ่มรายการ"}
                  </button>
                </div>
              );
            })}
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
        <PayeeBreakdown items={items} />
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
      {startupModalCat && (
        <StartupItemsModal
          projectId={id}
          category={startupModalCat}
          items={items}
          setItems={setItems}
          onClose={() => setStartupModalCat(null)}
        />
      )}
    </div>
  );
}

// ── payee breakdown — "this project paid X to whom" ──────────────
function PayeeBreakdown({ items }: { items: StartupItem[] }) {
  const total = items.reduce((s, i) => s + i.amount, 0);
  const byPayee = useMemo(() => {
    const m = new Map<string, { amount: number; count: number }>();
    for (const it of items) {
      const key = (it.payee ?? "").trim() || "(ไม่ระบุผู้รับเงิน)";
      const cur = m.get(key) ?? { amount: 0, count: 0 };
      cur.amount += it.amount; cur.count += 1;
      m.set(key, cur);
    }
    return [...m.entries()].map(([payee, v]) => ({
      payee, amount: v.amount, count: v.count,
      pct: total > 0 ? (v.amount / total) * 100 : 0
    })).sort((a, b) => b.amount - a.amount);
  }, [items, total]);

  if (items.length === 0) return null;
  return (
    <div className="card">
      <h3 className="font-bold text-slate-800 text-sm mb-2">จ่ายให้ใครไปเท่าไร (เงินลงทุน)</h3>
      <div className="space-y-1.5">
        {byPayee.map((p) => (
          <div key={p.payee}>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-slate-700 min-w-0 truncate">{p.payee}
                <span className="text-slate-400"> · {p.count} รายการ</span></span>
              <span className="tabular-nums whitespace-nowrap">
                {baht(p.amount)} <span className="text-slate-400">({p.pct.toFixed(1)}%)</span>
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-100 mt-0.5">
              <div className="h-1.5 rounded-full bg-brand" style={{ width: `${Math.min(100, p.pct)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── startup-category ledger modal ────────────────────────────────
function StartupItemsModal({ projectId, category, items, setItems, onClose }: {
  projectId: number; category: string;
  items: StartupItem[]; setItems: React.Dispatch<React.SetStateAction<StartupItem[]>>;
  onClose: () => void;
}) {
  const { confirm, ConfirmDialog } = useConfirm();
  const catItems = items.filter((i) => i.category === category);
  const blank = (): Omit<StartupItem, "id"> => ({
    category, paid_date: null, item_name: "", payee: null, amount: 0,
    wht_mode: "none", wht_value: 0, doc_type: null, payment_status: "paid"
  });
  const [editing, setEditing] = useState<StartupItem | null>(null);
  const [form, setForm] = useState<Omit<StartupItem, "id">>(blank());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function startAdd() { setEditing(null); setForm(blank()); }
  function startEdit(it: StartupItem) {
    setEditing(it);
    setForm({ ...it });
  }
  const fset = <K extends keyof Omit<StartupItem, "id">>(k: K, v: Omit<StartupItem, "id">[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  async function submit() {
    setErr(null);
    if (!form.item_name.trim()) { setErr("กรุณากรอกชื่อรายการ"); return; }
    setBusy(true);
    const body = {
      category, paid_date: form.paid_date || null, item_name: form.item_name.trim(),
      payee: form.payee?.trim() || null, amount: Number(form.amount) || 0,
      wht_mode: form.wht_mode, wht_value: Number(form.wht_value) || 0,
      doc_type: form.doc_type, payment_status: form.payment_status
    };
    try {
      if (editing) {
        const res = await fetch(apiUrl(`/api/feasibility/${projectId}/startup-items/${editing.id}`), {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
        setItems((p) => p.map((i) => i.id === editing.id ? { ...editing, ...body } : i));
      } else {
        const res = await fetch(apiUrl(`/api/feasibility/${projectId}/startup-items`), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "เพิ่มไม่สำเร็จ")); return; }
        setItems((p) => [...p, { id: Number(j.id), ...body }]);
      }
      startAdd();
    } finally { setBusy(false); }
  }

  async function remove(it: StartupItem) {
    const ok = await confirm({ title: "ยืนยันการลบ", body: `ลบรายการ "${it.item_name}" ?`, confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger" });
    if (ok === null) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/feasibility/${projectId}/startup-items/${it.id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ลบไม่สำเร็จ")); return; }
      setItems((p) => p.filter((i) => i.id !== it.id));
      if (editing?.id === it.id) startAdd();
    } finally { setBusy(false); }
  }

  const catSum = catItems.reduce((s, i) => s + i.amount, 0);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {ConfirmDialog}
      <div className="bg-white rounded-2xl shadow-xl max-w-xl w-full p-5 space-y-3 max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-bold text-slate-800">{STARTUP_LABELS[category]} — รายการจ่าย</h3>
          <span className="text-sm font-bold tabular-nums">{baht(catSum)}</span>
        </div>

        {/* existing rows */}
        <div className="space-y-1.5">
          {catItems.length === 0 && <p className="text-xs text-slate-400">ยังไม่มีรายการ — เพิ่มด้านล่าง</p>}
          {catItems.map((it) => (
            <div key={it.id} className="flex items-center gap-2 border border-slate-100 rounded-lg px-2.5 py-1.5">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-800 truncate">{it.item_name}</div>
                <div className="text-[11px] text-slate-400 truncate">
                  {it.payee || "—"}{it.paid_date ? ` · ${it.paid_date}` : ""}
                  {" · "}{it.payment_status === "pending" ? <span className="text-amber-600">รอชำระ</span> : "ชำระแล้ว"}
                  {it.doc_type ? ` · ${it.doc_type === "tax_invoice" ? "ใบกำกับภาษี" : "ใบเสร็จ"}` : ""}
                  {it.wht_mode !== "none" ? ` · หัก ${baht(whtBaht(it.amount, it.wht_mode, it.wht_value))}` : ""}
                </div>
              </div>
              <div className="text-sm tabular-nums">{baht(it.amount)}</div>
              <button type="button" onClick={() => startEdit(it)} className="text-xs text-brand hover:underline">แก้</button>
              <button type="button" onClick={() => remove(it)} className="text-xs text-rose-500 hover:underline">ลบ</button>
            </div>
          ))}
        </div>

        {/* add / edit form */}
        <div className="border-t border-slate-100 pt-3 space-y-2">
          <div className="text-xs font-semibold text-slate-500">{editing ? "แก้ไขรายการ" : "เพิ่มรายการใหม่"}</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <label className="label !text-xs">ชื่อรายการสินค้า *</label>
              <input className="input !py-1.5 text-sm" value={form.item_name}
                onChange={(e) => fset("item_name", e.target.value)} />
            </div>
            <div>
              <label className="label !text-xs">วันที่ชำระเงิน</label>
              <input className="input !py-1.5 text-sm" type="date" value={form.paid_date ?? ""}
                onChange={(e) => fset("paid_date", e.target.value || null)} />
            </div>
            <div>
              <label className="label !text-xs">ผู้รับเงิน / ผู้จำหน่าย</label>
              <input className="input !py-1.5 text-sm" value={form.payee ?? ""}
                onChange={(e) => fset("payee", e.target.value || null)} />
            </div>
            <div>
              <label className="label !text-xs">จำนวนเงิน (฿)</label>
              <input className="input !py-1.5 text-sm" type="number" inputMode="decimal"
                value={form.amount === 0 ? "" : form.amount} placeholder="0"
                onChange={(e) => fset("amount", e.target.value === "" ? 0 : Number(e.target.value))} />
            </div>
            <div>
              <label className="label !text-xs">หัก ณ ที่จ่าย</label>
              <div className="flex gap-1">
                <select className="input !py-1.5 text-sm !w-auto" value={form.wht_mode}
                  onChange={(e) => fset("wht_mode", e.target.value)}>
                  <option value="none">ไม่มี</option>
                  <option value="baht">บาท</option>
                  <option value="pct">%</option>
                </select>
                {form.wht_mode !== "none" && (
                  <input className="input !py-1.5 text-sm flex-1" type="number" inputMode="decimal"
                    value={form.wht_value === 0 ? "" : form.wht_value}
                    placeholder={form.wht_mode === "pct" ? "เช่น 3" : "บาท"}
                    onChange={(e) => fset("wht_value", e.target.value === "" ? 0 : Number(e.target.value))} />
                )}
              </div>
            </div>
            <div>
              <label className="label !text-xs">ประเภทเอกสาร</label>
              <select className="input !py-1.5 text-sm" value={form.doc_type ?? ""}
                onChange={(e) => fset("doc_type", (e.target.value || null) as StartupItem["doc_type"])}>
                <option value="">— ไม่ระบุ —</option>
                <option value="tax_invoice">ใบกำกับภาษี</option>
                <option value="receipt">ใบเสร็จรับเงิน (ไม่มีภาษี)</option>
              </select>
            </div>
            <div>
              <label className="label !text-xs">สถานะการชำระ</label>
              <select className="input !py-1.5 text-sm" value={form.payment_status}
                onChange={(e) => fset("payment_status", e.target.value)}>
                <option value="paid">ชำระเงินแล้ว</option>
                <option value="pending">รอชำระ</option>
              </select>
            </div>
          </div>
          <p className="text-[10px] text-slate-400">อัพโหลดรูปเอกสารจะเพิ่มในเฟสถัดไป (กำลังประเมินระบบอ่านอัตโนมัติ)</p>
          {err && <p className="text-xs text-rose-600">{err}</p>}
          <div className="flex gap-2">
            {editing && (
              <button type="button" onClick={startAdd} disabled={busy}
                className="flex-1 py-2 rounded-lg border border-slate-300 text-sm">ยกเลิกแก้ไข</button>
            )}
            <button type="button" onClick={submit} disabled={busy}
              className="flex-1 btn-primary disabled:opacity-50">
              {busy ? "กำลังบันทึก…" : editing ? "บันทึกการแก้ไข" : "+ เพิ่มรายการ"}
            </button>
          </div>
        </div>

        <button type="button" onClick={onClose} className="w-full py-2 text-sm text-slate-500 hover:underline">ปิด</button>
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
