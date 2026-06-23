"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { fmtMoney } from "@/lib/format";
import { TH_MONTHS_FULL } from "@/lib/revshare";

type Result = {
  totalSales: number; tierGP: number; floorApplied: number; billedGP: number; topup: number;
  avgGpPct: number; vatAmount: number; whtAmount: number; netAmount: number;
};
type BreakRow = { label: string; start: string; end: string; sales: number; roundGP: number; gpPct: number };
type Stored = { status: "draft" | "issued" | "paid"; invoice_no: string | null; issued_at: string | null; paid_at: string | null } | null;
type Preview = { result: Result; breakdown: BreakRow[]; opMonth: number; stored: Stored; stale: boolean };
type Partner = { id: number; name: string; venue: string | null; vat_enabled: boolean; line_group_id: string | null };
type Seller = { name: string; address: string | null; taxBranchCode: string | null; phone: string | null };

export default function SettlementClient({
  partner, seller, initial, year, month
}: { partner: Partner; seller: Seller; initial: Preview; year: number; month: number }) {
  const router = useRouter();
  const [pv, setPv] = useState<Preview>(initial);
  const [invoiceNo, setInvoiceNo] = useState(initial.stored?.invoice_no ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);

  const r = pv.result;
  const monthLabel = `${TH_MONTHS_FULL[month]} ${year + 543}`;
  const status = pv.stored?.status ?? "draft";
  const withVat = partner.vat_enabled && r.vatAmount > 0;
  const grandTotal = r.billedGP + r.vatAmount;   // ยอดบนใบกำกับภาษี

  function shift(delta: number) {
    const d = new Date(Date.UTC(year, month - 1 + delta, 1));
    router.push(`/admin/accounta/revshare/settlement?partner=${partner.id}&year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}`);
  }

  async function action(act: "save" | "issue" | "mark_paid" | "revert") {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/accounta/revshare/settlement"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partner: partner.id, year, month, action: act, invoice_no: invoiceNo.trim() || null })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ทำรายการไม่สำเร็จ")); return; }
      setPv({ result: j.result, breakdown: j.breakdown, opMonth: j.opMonth, stored: j.stored, stale: j.stale });
      router.refresh();
    } finally { setBusy(false); }
  }

  function statementText(): string {
    const L: string[] = [];
    L.push(`ใบสรุปส่วนแบ่งยอดขาย (GP)`);
    L.push(seller.name);
    L.push(`คู่ค้า: ${partner.name}${partner.venue ? ` (${partner.venue})` : ""}`);
    L.push(`รอบเดือน: ${monthLabel}`);
    L.push(`────────────`);
    L.push(`ยอดขายรวมทั้งเดือน: ${fmtMoney(r.totalSales)} บาท`);
    L.push(`GP ตามขั้นบันได: ${fmtMoney(r.tierGP)} บาท (เฉลี่ย ${(r.avgGpPct * 100).toFixed(2)}%)`);
    if (r.topup > 0) L.push(`  • ยังไม่ถึงขั้นต่ำ — เรียกเก็บที่ยอดขั้นต่ำ ${fmtMoney(r.floorApplied)} บาท`);
    L.push(`GP เรียกเก็บ: ${fmtMoney(r.billedGP)} บาท`);
    if (withVat) {
      L.push(`VAT 7%: ${fmtMoney(r.vatAmount)} บาท`);
      L.push(`รวมตามใบกำกับภาษี: ${fmtMoney(grandTotal)} บาท`);
    }
    L.push(`หัก ณ ที่จ่าย 3%: −${fmtMoney(r.whtAmount)} บาท`);
    L.push(`รับสุทธิ: ${fmtMoney(r.netAmount)} บาท`);
    return L.join("\n");
  }
  async function copy() {
    try { await navigator.clipboard.writeText(statementText()); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { setErr("คัดลอกไม่สำเร็จ"); }
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

      {/* Month nav + status */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => shift(-1)} disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">←</button>
          <span className="text-sm font-bold text-slate-700">{monthLabel}</span>
          <button type="button" onClick={() => shift(1)} disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">→</button>
        </div>
        <span className={`text-xs px-2 py-1 rounded font-medium ${STATUS[status].c}`}>{STATUS[status].t} · สัญญาเดือนที่ {pv.opMonth}</span>
      </div>

      {pv.stale && status !== "draft" && (
        <div className="card bg-amber-50 border border-amber-200 text-sm text-amber-800">
          ยอดขายของรอบมีการเปลี่ยนแปลงหลังออกใบเรียกเก็บ — ตัวเลขด้านล่างเป็นค่าล่าสุด กด “บันทึก/คำนวณใหม่” เพื่ออัปเดต snapshot
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card label="ยอดขายรวมทั้งเดือน" value={r.totalSales} />
        <Card label="GP ขั้นบันได" value={r.tierGP} sub={`เฉลี่ย ${(r.avgGpPct * 100).toFixed(2)}%`} />
        <Card label="ส่วนต่างขั้นต่ำ (top-up)" value={r.topup} sub={r.topup > 0 ? `ขั้นต่ำ ฿${fmtMoney(r.floorApplied)}` : "ไม่ถึงขั้นต่ำ"} tone={r.topup > 0 ? "amber" : undefined} />
        <Card label="GP เรียกเก็บ" value={r.billedGP} tone="brand" big />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {withVat && <Card label="VAT 7%" value={r.vatAmount} />}
        {withVat && <Card label="รวมตามใบกำกับภาษี" value={grandTotal} />}
        <Card label="หัก ณ ที่จ่าย 3%" value={-r.whtAmount} tone="rose" />
        <Card label="รับสุทธิ" value={r.netAmount} tone="emerald" big />
      </div>

      {/* Money-direction note */}
      <div className="card text-xs text-slate-500 space-y-1">
        <div className="font-bold text-slate-700">ทิศทางเงิน</div>
        <div>• รายสัปดาห์: {seller.name} โอนยอดขายเต็มจำนวนให้คู่ค้า (ยังไม่หัก GP)</div>
        <div>• สิ้นเดือน: ออกใบเรียกเก็บ GP รวมครั้งเดียว ฿{fmtMoney(r.billedGP)}{withVat ? ` + VAT ฿${fmtMoney(r.vatAmount)} = ฿${fmtMoney(grandTotal)}` : ""} → คู่ค้าจ่ายแล้วหัก ณ ที่จ่าย 3% (฿{fmtMoney(r.whtAmount)}) → รับสุทธิ ฿{fmtMoney(r.netAmount)}</div>
      </div>

      {/* Round breakdown */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">สรุปรายสัปดาห์ (ยอดโอน + GP)</div>
        {pv.breakdown.length === 0 ? (
          <p className="text-xs text-slate-400">ยังไม่มีข้อมูลในเดือนนี้ — <Link href={`/admin/accounta/revshare/rounds?partner=${partner.id}&year=${year}&month=${month}`} className="text-brand hover:underline">ไปนำเข้ายอดขายรายวัน</Link></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead><tr className="text-[11px] text-slate-400 border-b border-slate-200">
                <th className="text-left py-1.5 px-2">สัปดาห์</th><th className="text-right py-1.5 px-2">ยอดโอน</th>
                <th className="text-right py-1.5 px-2">GP</th><th className="text-right py-1.5 px-2">GP%</th>
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
          {status === "issued" && <button type="button" onClick={() => action("mark_paid")} disabled={busy} className="rounded-md bg-sky-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-sky-700">บันทึกรับชำระ</button>}
          {status !== "draft" && <button type="button" onClick={() => action("revert")} disabled={busy} className="text-sm text-rose-600 hover:underline px-2">ย้อนกลับเป็นร่าง</button>}
        </div>
        {pv.stored?.issued_at && <p className="text-[11px] text-slate-400">ออกใบเมื่อ {new Date(pv.stored.issued_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}{pv.stored.paid_at ? ` · รับชำระ ${new Date(pv.stored.paid_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}` : ""}</p>}
      </div>

      {/* Statement (partner-ready) — visual preview of the LINE card */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-bold text-slate-800">การ์ดที่จะส่งให้คู่ค้า</div>
          <div className="flex items-center gap-2 flex-wrap">
            {partner.line_group_id
              ? <button type="button" onClick={sendNotify} disabled={busy} className="rounded-md bg-emerald-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">{sent ? "✓ ส่งแล้ว" : "ส่งการ์ดเข้ากลุ่มคู่ค้า (LINE)"}</button>
              : <span className="text-[11px] text-slate-400">ตั้ง LINE group ในหน้าตั้งค่าคู่ค้าเพื่อส่งการ์ดได้</span>}
            <button type="button" onClick={copy} className="btn-secondary text-sm">{copied ? "✓ คัดลอกแล้ว" : "คัดลอกข้อความ (ส่ง LINE)"}</button>
            <a href={apiUrl(`/api/accounta/revshare/statement/pdf?partner=${partner.id}&year=${year}&month=${month}`)} className="btn-secondary text-sm" download>ดาวน์โหลด PDF</a>
          </div>
        </div>
        <p className="text-[11px] text-slate-400">ตัวอย่างการ์ดที่คู่ค้าจะเห็นใน LINE — ส่งแล้วหน้าตาเป็นแบบนี้</p>
        <div className="rounded-2xl bg-slate-100 p-4 sm:p-6 flex justify-center">
          <FlexCardPreview
            shop={partner.venue?.trim() || partner.name}
            legalName={partner.venue?.trim() ? partner.name : null}
            sellerName={seller.name}
            monthLabel={monthLabel}
            invoiceNo={invoiceNo.trim() || null}
            weeks={pv.breakdown.map((b) => ({ label: b.label, sales: b.sales }))}
            r={r} withVat={withVat} grandTotal={grandTotal}
          />
        </div>
      </div>
    </div>
  );
}

/** Static mock of the LINE Flex bubble (mirrors revshareSettlementFlex) so the
 *  owner sees exactly what lands in the partner's group before sending. */
function FlexCardPreview({
  shop, legalName, sellerName, monthLabel, invoiceNo, weeks, r, withVat, grandTotal
}: {
  shop: string; legalName: string | null; sellerName: string; monthLabel: string;
  invoiceNo: string | null; weeks: Array<{ label: string; sales: number }>;
  r: Result; withVat: boolean; grandTotal: number;
}) {
  const baht = (n: number) => `${fmtMoney(n)} บาท`;
  const belowFloor = r.topup > 0;   // tier GP didn't reach the agreed minimum
  const Row = ({ label, value, bold, color }: { label: string; value: string; bold?: boolean; color?: string }) => (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[13px] text-slate-500">{label}</span>
      <span className={`text-[13px] tabular-nums ${bold ? "font-bold" : ""}`} style={color ? { color } : undefined}>{value}</span>
    </div>
  );
  return (
    <div className="w-full max-w-[320px] rounded-[18px] overflow-hidden bg-white shadow-lg ring-1 ring-black/5">
      {/* header */}
      <div className="px-4 py-4" style={{ backgroundColor: "#281a0e" }}>
        <div className="text-[10px]" style={{ color: "#d6a14d" }}>IKIGAI OS · ส่วนแบ่งยอดขาย (GP)</div>
        <div className="text-base font-bold text-white leading-tight mt-0.5">สรุปรอบ {monthLabel}</div>
        <div className="text-[11px]" style={{ color: "#cbb89a" }}>{invoiceNo ? `เลขที่ ${invoiceNo}` : "ใบสรุปส่วนแบ่งยอดขาย"}</div>
      </div>
      {/* body */}
      <div className="px-4 py-4 space-y-2">
        <div className="text-[15px] font-bold text-slate-800 leading-tight">{shop}</div>
        {legalName && <div className="text-[10px] text-slate-400 leading-tight">{legalName}</div>}
        <div className="text-[10px] text-slate-400">ผู้เรียกเก็บ: {sellerName}</div>
        {weeks.length > 0 && (
          <>
            <div className="border-t border-slate-100 my-1" />
            <div className="text-[11px] font-bold text-slate-400">ยอดโอนรายสัปดาห์</div>
            {weeks.map((w, i) => <Row key={i} label={w.label} value={baht(w.sales)} />)}
          </>
        )}
        <div className="border-t border-slate-100 my-1" />
        <Row label="ยอดขายรวมทั้งเดือน" value={baht(r.totalSales)} />
        <Row label={`GP ตามขั้นบันได (${(r.avgGpPct * 100).toFixed(2)}%)`} value={baht(r.tierGP)} />
        {belowFloor && (
          <>
            <Row label="ขั้นต่ำที่ตกลงกัน" value={baht(r.floorApplied)} color="#854f0b" />
            <div className="text-[10px] leading-snug" style={{ color: "#854f0b" }}>ยังไม่ถึงขั้นต่ำ — เรียกเก็บที่ยอดขั้นต่ำ</div>
          </>
        )}
        <Row label="GP เรียกเก็บ" value={baht(r.billedGP)} bold />
        {withVat && <Row label="VAT 7%" value={baht(r.vatAmount)} />}
        {withVat && <Row label="รวมใบกำกับภาษี" value={baht(grandTotal)} bold />}
        <Row label="หัก ณ ที่จ่าย 3%" value={`−${baht(r.whtAmount)}`} color="#a32d2d" />
        <div className="border-t border-slate-100 my-1" />
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-bold text-slate-600">รับสุทธิ</span>
          <span className="text-[15px] font-bold tabular-nums" style={{ color: "#0f6e56" }}>{baht(r.netAmount)}</span>
        </div>
      </div>
      {/* footer */}
      <div className="px-4 pb-3 pt-1">
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
