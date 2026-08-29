"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { fmtMoney } from "@/lib/format";
import { TH_MONTHS_FULL, partnerShopName } from "@/lib/revshare";

type Result = {
  totalSales: number; tierGP: number; floorApplied: number; billedGP: number; topup: number;
  avgGpPct: number; vatAmount: number; whtAmount: number; netAmount: number;
  drinkPassthrough: number; drinkInputVat: number; netAfterDrinks: number;
};
type BreakRow = { label: string; start: string; end: string; sales: number; roundGP: number; gpPct: number };
type Stored = { status: "draft" | "issued" | "paid"; invoice_no: string | null; issued_at: string | null; paid_at: string | null } | null;
type Preview = { result: Result; breakdown: BreakRow[]; opMonth: number; months: string[]; stored: Stored; stale: boolean };
type MonthOption = { ym: string; year: number; month: number; label: string; sales: number; settled: boolean; isAnchor: boolean };
type Partner = { id: number; name: string; venue: string | null; pos_categories: string[]; vat_enabled: boolean; line_group_id: string | null };
type Seller = { name: string; company: string | null; address: string | null; taxBranchCode: string | null; phone: string | null };

function monthKeyLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${TH_MONTHS_FULL[m]} ${y + 543}`;
}

export default function SettlementClient({
  partner, seller, initial, year, month, monthOptions
}: { partner: Partner; seller: Seller; initial: Preview; year: number; month: number; monthOptions: MonthOption[] }) {
  const router = useRouter();
  const [pv, setPv] = useState<Preview>(initial);
  const [invoiceNo, setInvoiceNo] = useState(initial.stored?.invoice_no ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // Which months are rolled into this settlement (the anchor is always in).
  const [selected, setSelected] = useState<Set<string>>(new Set(initial.months));

  const r = pv.result;
  const monthLabel = `${TH_MONTHS_FULL[month]} ${year + 543}`;
  const coveredMonths = pv.months.length ? pv.months : [`${year}-${String(month).padStart(2, "0")}`];
  const combined = coveredMonths.length > 1;
  // No abbreviations — full month names joined with "+" (owner 2026-08).
  const periodLabel = coveredMonths.map(monthKeyLabel).join(" + ");
  const shop = partnerShopName(partner);
  const status = pv.stored?.status ?? "draft";
  const withVat = partner.vat_enabled && r.vatAmount > 0;
  const grandTotal = r.billedGP + r.vatAmount;   // ยอดบนใบกำกับภาษี
  const hasDrinks = r.drinkPassthrough > 0;      // สวัสดิการเครื่องดื่มพนักงาน (ไม่คิด GP)

  // Navigate to a covered set (server recomputes preview + the picker). Month
  // shift resets to a single-month (the new anchor); toggling a month re-navs
  // with the new set. `key` on this component (in page.tsx) remounts it so the
  // seeded state stays in sync with the URL.
  function goToMonths(y: number, m: number, keys: string[]) {
    const uniq = Array.from(new Set(keys)).sort();
    const qs = `partner=${partner.id}&year=${y}&month=${m}` + (uniq.length ? `&months=${uniq.join(",")}` : "");
    router.push(`/admin/accounta/revshare/settlement?${qs}`);
  }
  function shift(delta: number) {
    const d = new Date(Date.UTC(year, month - 1 + delta, 1));
    goToMonths(d.getUTCFullYear(), d.getUTCMonth() + 1, []);
  }
  function toggleMonth(ym: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(ym); else next.delete(ym);
    next.add(`${year}-${String(month).padStart(2, "0")}`);   // anchor is mandatory
    setSelected(next);
    goToMonths(year, month, [...next]);
  }

  async function action(act: "save" | "issue" | "mark_paid" | "revert") {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/accounta/revshare/settlement"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partner: partner.id, year, month, months: coveredMonths, action: act, invoice_no: invoiceNo.trim() || null })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ทำรายการไม่สำเร็จ")); return; }
      setPv({ result: j.result, breakdown: j.breakdown, opMonth: j.opMonth, months: j.months, stored: j.stored, stale: j.stale });
      router.refresh();
    } finally { setBusy(false); }
  }

  async function sendNotify() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/accounta/revshare/notify"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partner: partner.id, year, month, kind: "settlement" })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ส่ง LINE ไม่สำเร็จ")); return; }
      setSent(true); setTimeout(() => setSent(false), 2200);
    } finally { setBusy(false); }
  }

  const STATUS = {
    draft: { t: "ร่าง", c: "bg-amber-100 text-amber-700" },
    issued: { t: "ออกใบเรียกเก็บแล้ว", c: "bg-emerald-100 text-emerald-700" },
    paid: { t: "รับชำระแล้ว", c: "bg-sky-100 text-sky-700" }
  } as const;

  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-rose-600">{err}</p>}

      {/* Anchor-month nav + status */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => shift(-1)} disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">←</button>
          <span className="text-sm font-bold text-slate-700">{monthLabel}</span>
          <button type="button" onClick={() => shift(1)} disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">→</button>
        </div>
        <span className={`text-xs px-2 py-1 rounded font-medium ${STATUS[status].c}`}>{STATUS[status].t} · สัญญาเดือนที่ {pv.opMonth}</span>
      </div>

      {/* Combine-months checklist (owner 2026-08 redesign) */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">รวมยอดขายเพื่อคิดส่วนแบ่ง</div>
        <p className="text-[11px] text-slate-400">
          เลือกเดือนก่อนหน้าที่ยังไม่ได้สรุปยอด มารวมคิดส่วนแบ่งกับ{monthLabel} · เดือนที่สรุปยอดไปแล้วจะเลือกไม่ได้
        </p>
        <div className="grid sm:grid-cols-2 gap-1.5">
          {monthOptions.map((o) => {
            const checked = o.isAnchor || coveredMonths.includes(o.ym);
            const locked = o.isAnchor || o.settled;
            return (
              <label key={o.ym}
                className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${checked ? "border-brand bg-brand/5" : "border-slate-200"} ${o.settled ? "opacity-60" : ""} ${busy || locked ? "cursor-default" : "cursor-pointer hover:border-slate-300"}`}>
                <span className="flex items-center gap-2 min-w-0">
                  <input type="checkbox" checked={checked} disabled={busy || locked}
                    onChange={(e) => toggleMonth(o.ym, e.target.checked)}
                    className="accent-brand h-4 w-4 shrink-0" />
                  <span className="truncate text-sm">
                    <span className="text-slate-700">{o.label}</span>
                    {o.isAnchor && <span className="text-[10px] text-brand ml-1.5">เดือนที่สรุป</span>}
                    {o.settled && <span className="text-[10px] text-slate-400 ml-1.5">สรุปยอดแล้ว</span>}
                  </span>
                </span>
                <span className="text-xs font-mono text-slate-500 shrink-0">฿{fmtMoney(o.sales)}</span>
              </label>
            );
          })}
        </div>
        {combined && (
          <p className="text-[11px] text-slate-500">
            รวม {coveredMonths.length} เดือน ({periodLabel}) — คิดส่วนแบ่งแบบขั้นบันไดจากยอดขายรวม และใช้ยอดขั้นต่ำเป็นผลรวมขั้นต่ำของแต่ละเดือน
          </p>
        )}
      </div>

      {pv.stale && status !== "draft" && (
        <div className="card bg-amber-50 border border-amber-200 text-sm text-amber-800">
          ยอดขายของรอบมีการเปลี่ยนแปลงหลังออกใบเรียกเก็บ — ตัวเลขด้านล่างเป็นค่าล่าสุด กด “บันทึก/คำนวณใหม่” เพื่ออัปเดต snapshot
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card label={combined ? `ยอดขายรวม ${coveredMonths.length} เดือน` : "ยอดขายรวมทั้งเดือน"} value={r.totalSales} />
        <Card label="ส่วนแบ่งตามขั้นบันได" value={r.tierGP} sub={`เฉลี่ย ${(r.avgGpPct * 100).toFixed(2)}%`} />
        <Card label="ส่วนต่างขั้นต่ำ (top-up)" value={r.topup} sub={r.topup > 0 ? `ขั้นต่ำ ฿${fmtMoney(r.floorApplied)}` : "ไม่ถึงขั้นต่ำ"} tone={r.topup > 0 ? "amber" : undefined} />
        <Card label="ส่วนแบ่งยอดขาย (ก่อนภาษี)" value={r.billedGP} tone="brand" big />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {withVat && <Card label="VAT 7%" value={r.vatAmount} />}
        {withVat && <Card label="รวมตามใบกำกับภาษี" value={grandTotal} />}
        <Card label="หัก ณ ที่จ่าย 3%" value={-r.whtAmount} tone="rose" />
        <Card label={hasDrinks ? "GP สุทธิ (คู่ค้าจ่ายบริษัท)" : "ยอดสุทธิ"} value={r.netAmount} tone="emerald" big={!hasDrinks} />
      </div>
      {hasDrinks && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card label="ค่าเครื่องดื่มพนักงาน (ไม่คิด GP)" value={-r.drinkPassthrough} tone="amber" sub={`บริษัทจ่ายคู่ค้า · VAT ซื้อ ฿${fmtMoney(r.drinkInputVat)}`} />
          <Card label="ยอดสุทธิหลังหักเครื่องดื่ม" value={r.netAfterDrinks} tone="emerald" big sub={r.netAfterDrinks >= 0 ? "คู่ค้าจ่ายบริษัท" : "บริษัทจ่ายคู่ค้า"} />
        </div>
      )}

      {/* Money-direction note */}
      <div className="card text-xs text-slate-500 space-y-1">
        <div className="font-bold text-slate-700">ทิศทางเงิน</div>
        <div>• รายสัปดาห์: {seller.name} โอนยอดขายเต็มจำนวนให้คู่ค้า (ยังไม่หักส่วนแบ่ง)</div>
        <div>• สิ้นเดือน: ออกใบเรียกเก็บส่วนแบ่งยอดขายรวมครั้งเดียว ฿{fmtMoney(r.billedGP)}{withVat ? ` + VAT ฿${fmtMoney(r.vatAmount)} = ฿${fmtMoney(grandTotal)}` : ""} → คู่ค้าจ่ายแล้วหักภาษี ณ ที่จ่าย 3% (฿{fmtMoney(r.whtAmount)}) → ยอดสุทธิ ฿{fmtMoney(r.netAmount)}</div>
      </div>

      {/* Round breakdown */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">สรุปรายสัปดาห์ (ยอดโอน + ส่วนแบ่ง)</div>
        {pv.breakdown.length === 0 ? (
          <p className="text-xs text-slate-400">ยังไม่มีข้อมูลในเดือนนี้ — <Link href={`/admin/accounta/revshare/rounds?partner=${partner.id}&year=${year}&month=${month}`} className="text-brand hover:underline">ไปนำเข้ายอดขายรายวัน</Link></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead><tr className="text-[11px] text-slate-400 border-b border-slate-200">
                <th className="text-left py-1.5 px-2">สัปดาห์</th><th className="text-right py-1.5 px-2">ยอดโอน</th>
                <th className="text-right py-1.5 px-2">ส่วนแบ่ง</th><th className="text-right py-1.5 px-2">ส่วนแบ่ง %</th>
              </tr></thead>
              <tbody>
                {pv.breakdown.map((b, i) => (
                  <tr key={i} className="border-b border-slate-50">
                    <td className="py-1.5 px-2 text-slate-600 whitespace-nowrap">{b.label}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{fmtMoney(b.sales)}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-emerald-700">{fmtMoney(b.roundGP)}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-slate-500">{(b.gpPct * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t-2 border-slate-200 font-bold">
                <td className="py-1.5 px-2">รวม</td>
                <td className="py-1.5 px-2 text-right font-mono">฿{fmtMoney(r.totalSales)}</td>
                <td className="py-1.5 px-2 text-right font-mono text-emerald-700">฿{fmtMoney(r.tierGP)}</td>
                <td className="py-1.5 px-2 text-right font-mono text-slate-500">{(r.avgGpPct * 100).toFixed(1)}%</td>
              </tr></tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="card space-y-3">
        <div className="text-sm font-bold text-slate-800">ออกใบเรียกเก็บ</div>
        <div className="flex flex-wrap items-end gap-2">
          <div><label className="label">เลขที่ใบเรียกเก็บ/ใบกำกับ (ถ้ามี)</label><input className="input w-48" value={invoiceNo} maxLength={60} placeholder="เช่น GP-2569-06" onChange={(e) => setInvoiceNo(e.target.value)} /></div>
          <button type="button" onClick={() => action("save")} disabled={busy} className="btn-secondary text-sm">บันทึก/คำนวณใหม่ (ร่าง)</button>
          {status === "draft" && <button type="button" onClick={() => action("issue")} disabled={busy || r.billedGP <= 0} className="btn-primary text-sm disabled:opacity-50">ออกใบเรียกเก็บ</button>}
          {status === "issued" && <button type="button" onClick={() => action("mark_paid")} disabled={busy} className="rounded-full bg-sky-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-sky-700">บันทึกรับชำระ</button>}
          {status !== "draft" && <button type="button" onClick={() => action("revert")} disabled={busy} className="text-sm text-rose-600 hover:underline px-2">ย้อนกลับเป็นร่าง</button>}
        </div>
        {pv.stored?.issued_at && <p className="text-[11px] text-slate-400">ออกใบเมื่อ {new Date(pv.stored.issued_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}{pv.stored.paid_at ? ` · รับชำระ ${new Date(pv.stored.paid_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}` : ""}</p>}
      </div>

      {/* Partner-ready notification — visual preview of the LINE message */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-bold text-slate-800">สรุปยอดขายประจำเดือน (พร้อมส่วนแบ่งยอดขาย)</div>
          <div className="flex items-center gap-2 flex-wrap">
            {partner.line_group_id
              ? <button type="button" onClick={sendNotify} disabled={busy} className="rounded-full bg-emerald-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">{sent ? "✓ ส่งแล้ว" : "ส่งสรุปประจำเดือนเข้ากลุ่มคู่ค้า"}</button>
              : <span className="text-[11px] text-slate-400">ตั้ง LINE group ในหน้าตั้งค่าคู่ค้าเพื่อส่งได้</span>}
            <a href={apiUrl(`/api/accounta/revshare/statement/pdf?partner=${partner.id}&year=${year}&month=${month}`)} className="btn-secondary text-sm" download>ดาวน์โหลด PDF</a>
          </div>
        </div>
        <p className="text-[11px] text-slate-400">ตัวอย่างข้อความแจ้งเตือนที่คู่ค้าจะเห็นใน LINE · ยอดขายรายวัน/รายสัปดาห์ส่งจากหน้ารอบยอดขาย</p>
        <div className="rounded-2xl bg-slate-100 p-4 sm:p-6">
          <FlexCardPreview
            shop={shop}
            partnerLegal={partner.name !== shop ? partner.name : null}
            sellerName={seller.name}
            sellerCompany={seller.company}
            monthLabel={periodLabel}
            combined={combined}
            invoiceNo={invoiceNo.trim() || null}
            r={r} withVat={withVat} grandTotal={grandTotal}
          />
        </div>
      </div>
    </div>
  );
}

/** Static mock of the monthly LINE message (mirrors revshareSettlementFlex) so
 *  the owner sees exactly what lands in the partner's group before sending.
 *  Full-width so long baht amounts never wrap. Billed by the seller
 *  (HYPOPLARAEMIA · อิคิไก เวลล์เทรด). The daily/weekly cards are separate. */
function FlexCardPreview({
  shop, partnerLegal, sellerName, sellerCompany, monthLabel, combined, invoiceNo, r, withVat, grandTotal
}: {
  shop: string; partnerLegal: string | null; sellerName: string; sellerCompany: string | null; monthLabel: string;
  combined: boolean; invoiceNo: string | null;
  r: Result; withVat: boolean; grandTotal: number;
}) {
  const baht = (n: number) => `${fmtMoney(n)} บาท`;
  const belowFloor = r.topup > 0;   // tier GP didn't reach the agreed minimum
  const hasDrinks = r.drinkPassthrough > 0;   // staff drink welfare (no GP)
  const sellerIssuer = sellerCompany ? `${sellerName} · ${sellerCompany}` : sellerName;
  const Row = ({ label, value, bold, color }: { label: string; value: string; bold?: boolean; color?: string }) => (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[13px] text-slate-500">{label}</span>
      <span className={`text-[13px] tabular-nums whitespace-nowrap ${bold ? "font-bold" : ""}`} style={color ? { color } : undefined}>{value}</span>
    </div>
  );
  return (
    <div className="w-full rounded-[18px] overflow-hidden bg-white shadow-lg ring-1 ring-black/5">
      {/* header */}
      <div className="px-5 py-4" style={{ backgroundColor: "#281a0e" }}>
        <div className="text-[10px]" style={{ color: "#d6a14d" }}>IKIGAI OS · ส่วนแบ่งยอดขาย</div>
        <div className="text-lg font-bold text-white leading-tight mt-0.5">สรุปยอดขายประจำเดือน · {monthLabel}</div>
        <div className="text-[11px]" style={{ color: "#cbb89a" }}>{invoiceNo ? `ส่วนแบ่งยอดขาย · เลขที่ ${invoiceNo}` : "พร้อมส่วนแบ่งยอดขาย"}</div>
      </div>
      {/* body */}
      <div className="px-5 py-4 space-y-2">
        <div className="text-[15px] font-bold text-slate-800 leading-tight">{shop}</div>
        {partnerLegal && <div className="text-[10px] text-slate-400 leading-tight">{partnerLegal}</div>}

        {/* ── ส่วนแบ่งยอดขาย (billed by the seller) ── */}
        <div className="border-t border-slate-100 my-1" />
        <div className="text-[10px] text-slate-400">ผู้เรียกเก็บ: {sellerIssuer}</div>
        <Row label={combined ? "ยอดขายรวมทุกเดือนที่รวม" : "ยอดขายรวมทั้งเดือน"} value={baht(r.totalSales)} />
        {belowFloor && (
          <>
            <Row label={`ส่วนแบ่งตามขั้นบันได (${(r.avgGpPct * 100).toFixed(2)}%)`} value={baht(r.tierGP)} />
            <Row label="ขั้นต่ำที่ตกลงกัน" value={baht(r.floorApplied)} color="#854f0b" />
            <div className="text-[10px] leading-snug" style={{ color: "#854f0b" }}>ยังไม่ถึงขั้นต่ำ — เรียกเก็บที่ยอดขั้นต่ำ</div>
          </>
        )}
        <Row label="ส่วนแบ่งยอดขายทั้งหมด (ก่อนภาษี)" value={baht(r.billedGP)} bold />
        <div className="text-[10px] text-slate-400 -mt-1">ส่วนแบ่งเฉลี่ย {(r.avgGpPct * 100).toFixed(2)}% ของยอดขาย</div>
        {withVat && <Row label="VAT 7%" value={baht(r.vatAmount)} />}
        {withVat && <Row label="ส่วนแบ่งยอดขายและภาษีทั้งหมด" value={baht(grandTotal)} bold />}
        <Row label="หักภาษี ณ ที่จ่าย 3%" value={`−${baht(r.whtAmount)}`} color="#a32d2d" />
        <div className="border-t border-slate-100 my-1" />
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-[13px] font-bold text-slate-600">{hasDrinks ? "GP สุทธิ" : "ยอดสุทธิ"}</span>
          <span className="text-[15px] font-bold tabular-nums whitespace-nowrap" style={{ color: "#0f6e56" }}>{baht(r.netAmount)}</span>
        </div>
        {hasDrinks && (
          <>
            <Row label="ค่าเครื่องดื่มพนักงาน (บริษัทจ่าย · ไม่คิด GP)" value={`−${baht(r.drinkPassthrough)}`} color="#854f0b" />
            <div className="border-t border-slate-100 my-1" />
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-[13px] font-bold text-slate-600">ยอดสุทธิหลังหักเครื่องดื่ม</span>
              <span className="text-[15px] font-bold tabular-nums whitespace-nowrap" style={{ color: "#0f6e56" }}>{baht(r.netAfterDrinks)}</span>
            </div>
          </>
        )}
      </div>
      {/* footer */}
      <div className="px-5 pb-3 pt-1">
        <div className="text-[9px] text-slate-400 text-center">เอกสารแจ้งเตือนภายใน ไม่ใช่เอกสารทางภาษี</div>
      </div>
    </div>
  );
}

function Card({ label, value, sub, tone, big }: { label: string; value: number; sub?: string; tone?: "brand" | "emerald" | "rose" | "amber"; big?: boolean }) {
  const color = tone === "brand" ? "text-brand" : tone === "emerald" ? "text-emerald-700" : tone === "rose" ? "text-rose-600" : tone === "amber" ? "text-amber-700" : "text-slate-800";
  return (
    <div className="card py-3">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`font-bold ${big ? "text-2xl" : "text-lg"} ${color}`}>{value < 0 ? `(฿${fmtMoney(-value)})` : `฿${fmtMoney(value)}`}</div>
      {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
    </div>
  );
}
