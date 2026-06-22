"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { fmtMoney } from "@/lib/format";
import type { Tier, Floor, SalesBase } from "@/lib/revshare";

type Partner = {
  id: number; name: string; venue: string | null; start_date: string;
  sales_base: SalesBase; pos_categories: string[];
  vat_enabled: boolean; vat_rate: number; wht_rate: number; active: boolean; note: string | null;
};
type TierRow = { lower: string; upper: string; rate: string };
type FloorRow = { monthFrom: string; monthTo: string; amount: string };

const BASE_LABEL: Record<SalesBase, string> = {
  gross: "ยอดก่อนส่วนลด (Gross) — แนะนำ", after_discount: "หลังหักส่วนลด", nett: "ยอดสุทธิรวม VAT (Nett)"
};

export default function PartnerConfigClient({ partner, tiers, floors }: { partner: Partner; tiers: Tier[]; floors: Floor[] }) {
  const router = useRouter();
  const [name, setName] = useState(partner.name);
  const [venue, setVenue] = useState(partner.venue ?? "");
  const [startDate, setStartDate] = useState(partner.start_date);
  const [salesBase, setSalesBase] = useState<SalesBase>(partner.sales_base);
  const [posCats, setPosCats] = useState(partner.pos_categories.join(", "));
  const [vatEnabled, setVatEnabled] = useState(partner.vat_enabled);
  const [vatRate, setVatRate] = useState(String(partner.vat_rate * 100));
  const [whtRate, setWhtRate] = useState(String(partner.wht_rate * 100));
  const [tierRows, setTierRows] = useState<TierRow[]>(
    tiers.map((t) => ({ lower: String(t.lower), upper: t.upper == null ? "" : String(t.upper), rate: String(t.rate * 100) }))
  );
  const [floorRows, setFloorRows] = useState<FloorRow[]>(
    floors.map((f) => ({ monthFrom: String(f.monthFrom), monthTo: String(f.monthTo), amount: String(f.amount) }))
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  function setTier(i: number, k: keyof TierRow, v: string) {
    setTierRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  }
  function setFloor(i: number, k: keyof FloorRow, v: string) {
    setFloorRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  }

  async function save() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const tiersOut = tierRows
        .filter((r) => r.lower !== "" && r.rate !== "")
        .map((r) => ({ lower: Number(r.lower), upper: r.upper === "" ? null : Number(r.upper), rate: Number(r.rate) / 100 }));
      const floorsOut = floorRows
        .filter((r) => r.monthFrom !== "" && r.monthTo !== "" && r.amount !== "")
        .map((r) => ({ monthFrom: Number(r.monthFrom), monthTo: Number(r.monthTo), amount: Number(r.amount) }));
      const body = {
        id: partner.id, name: name.trim(), venue: venue.trim() || null, start_date: startDate,
        sales_base: salesBase,
        pos_categories: posCats.split(",").map((s) => s.trim()).filter(Boolean),
        vat_enabled: vatEnabled, vat_rate: Number(vatRate) / 100, wht_rate: Number(whtRate) / 100,
        tiers: tiersOut, floors: floorsOut
      };
      const res = await fetch(apiUrl("/api/accounta/revshare/partners"), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      setMsg("บันทึกแล้ว");
      router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-rose-600">{err}</p>}
      {msg && <p className="text-sm text-emerald-700">✓ {msg}</p>}

      {/* Basic */}
      <div className="card grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label className="label">ชื่อคู่ค้า</label><input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className="label">จุดขาย/พื้นที่</label><input className="input" value={venue} maxLength={120} onChange={(e) => setVenue(e.target.value)} /></div>
        <div><label className="label">วันเริ่มสัญญา</label><input type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
        <div>
          <label className="label">ฐานยอดขายที่ใช้คิด GP</label>
          <select className="input" value={salesBase} onChange={(e) => setSalesBase(e.target.value as SalesBase)}>
            {(Object.keys(BASE_LABEL) as SalesBase[]).map((b) => <option key={b} value={b}>{BASE_LABEL[b]}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label">หมวด POS ที่นับเป็นยอดขายของคู่ค้า (คั่นด้วยจุลภาค)</label>
          <input className="input" value={posCats} placeholder="เช่น SOFT DRINK" onChange={(e) => setPosCats(e.target.value)} />
        </div>
      </div>

      {/* VAT / WHT */}
      <div className="card space-y-3">
        <div className="text-sm font-bold text-slate-800">ภาษี</div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={vatEnabled} onChange={(e) => setVatEnabled(e.target.checked)} />
          ออก VAT บนค่า GP (ทั้งสองฝ่ายจด VAT)
        </label>
        <div className="grid grid-cols-2 gap-3 max-w-xs">
          <div><label className="label">VAT %</label><input type="number" step="0.01" className="input" value={vatRate} disabled={!vatEnabled} onChange={(e) => setVatRate(e.target.value)} /></div>
          <div><label className="label">หัก ณ ที่จ่าย %</label><input type="number" step="0.01" className="input" value={whtRate} onChange={(e) => setWhtRate(e.target.value)} /></div>
        </div>
        <p className="text-[11px] text-slate-400">VAT คิดบน GP ที่เรียกเก็บ · WHT หักจากฐาน GP ก่อน VAT (ไม่ทับซ้อนกัน)</p>
      </div>

      {/* Tiers */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">ขั้นบันได GP (คิดแบบ marginal — แต่ละชั้นคิดเฉพาะส่วนในชั้นนั้น)</div>
        <div className="space-y-1.5">
          {tierRows.map((r, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span className="text-[11px] text-slate-400 w-8">ชั้น {i + 1}</span>
              <span className="text-[11px] text-slate-500">ตั้งแต่</span>
              <input type="number" className="input w-28 text-right" value={r.lower} onChange={(e) => setTier(i, "lower", e.target.value)} />
              <span className="text-[11px] text-slate-500">ถึง</span>
              <input type="number" className="input w-28 text-right" value={r.upper} placeholder="ไม่จำกัด" onChange={(e) => setTier(i, "upper", e.target.value)} />
              <input type="number" step="0.01" className="input w-20 text-right" value={r.rate} onChange={(e) => setTier(i, "rate", e.target.value)} />
              <span className="text-[11px] text-slate-500">%</span>
              <button type="button" onClick={() => setTierRows((rs) => rs.filter((_, j) => j !== i))} className="text-[11px] text-rose-500 hover:underline">ลบ</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setTierRows((rs) => [...rs, { lower: "", upper: "", rate: "" }])} className="text-[11px] text-brand hover:underline">+ เพิ่มชั้น</button>
        <p className="text-[11px] text-slate-400">“ถึง” เว้นว่าง = ไม่จำกัด (ชั้นสูงสุด) · ฐานคิดคือยอดขายรวมทั้งเดือน</p>
      </div>

      {/* Floors */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">ยอดเรียกเก็บขั้นต่ำ (ตามเดือนที่ของสัญญา)</div>
        <div className="space-y-1.5">
          {floorRows.map((r, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span className="text-[11px] text-slate-500">เดือนที่</span>
              <input type="number" className="input w-16 text-right" value={r.monthFrom} onChange={(e) => setFloor(i, "monthFrom", e.target.value)} />
              <span className="text-[11px] text-slate-500">ถึง</span>
              <input type="number" className="input w-16 text-right" value={r.monthTo} onChange={(e) => setFloor(i, "monthTo", e.target.value)} />
              <span className="text-[11px] text-slate-500">ขั้นต่ำ ฿</span>
              <input type="number" className="input w-32 text-right" value={r.amount} onChange={(e) => setFloor(i, "amount", e.target.value)} />
              <button type="button" onClick={() => setFloorRows((rs) => rs.filter((_, j) => j !== i))} className="text-[11px] text-rose-500 hover:underline">ลบ</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setFloorRows((rs) => [...rs, { monthFrom: "", monthTo: "", amount: "" }])} className="text-[11px] text-brand hover:underline">+ เพิ่มช่วง</button>
        <p className="text-[11px] text-slate-400">นอกช่วงที่กำหนด = ไม่มีขั้นต่ำ (เช่น เดือนที่ 7 เป็นต้นไป ใส่ ฿{fmtMoney(0)})</p>
      </div>

      <div className="flex items-center gap-2">
        <button type="button" onClick={save} disabled={busy} className="btn-primary disabled:opacity-50">บันทึกการตั้งค่า</button>
      </div>
    </div>
  );
}
