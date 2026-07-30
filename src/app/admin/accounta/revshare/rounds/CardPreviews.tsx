"use client";

// Visual mocks of the daily / weekly LINE cards (mirror revshareDailyFlex /
// revshareWeeklyFlex) so the owner sees exactly what lands in the partner's
// group before sending (owner 2026-06-24: พรีวิวการ์ดทุกแบบก่อนกดส่ง).

import { useState } from "react";
import { fmtMoney } from "@/lib/format";
import { salesVat } from "@/lib/revshare";

const baht = (n: number) => `${fmtMoney(n)} บาท`;

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="w-full rounded-[18px] overflow-hidden bg-white shadow-lg ring-1 ring-black/5">
      <div className="px-5 py-4" style={{ backgroundColor: "#281a0e" }}>
        <div className="text-[10px]" style={{ color: "#d6a14d" }}>IKIGAI OS · ส่วนแบ่งยอดขาย</div>
        <div className="text-lg font-bold text-white leading-tight mt-0.5">{title}</div>
        <div className="text-[11px]" style={{ color: "#cbb89a" }}>{subtitle}</div>
      </div>
      <div className="px-5 py-4 space-y-2">{children}</div>
    </div>
  );
}
function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[13px] text-slate-500">{label}</span>
      <span className={`text-[13px] tabular-nums whitespace-nowrap ${bold ? "font-bold" : ""}`}>{value}</span>
    </div>
  );
}

export function DailyCardPreview({ shop, sellerName, dateLabel, sales, vatRate, salesIncludesVat = false, billCount }: {
  shop: string; sellerName: string; dateLabel: string; sales: number; vatRate: number; salesIncludesVat?: boolean; billCount?: number | null;
}) {
  const v = salesVat(sales, vatRate, salesIncludesVat);
  return (
    <Shell title="สรุปยอดขายประจำวัน" subtitle={dateLabel}>
      <div className="text-[15px] font-bold text-slate-800 leading-tight">{shop}</div>
      <div className="text-[10px] text-slate-400">บันทึกโดย: {sellerName}</div>
      <div className="border-t border-slate-100 my-1" />
      <Row label="ยอดขายวันนี้ (รวม VAT)" value={baht(v.total)} bold />
      <Row label="ยอดขายก่อนภาษี" value={baht(v.base)} />
      <Row label="VAT 7%" value={baht(v.vat)} />
      {billCount != null && <Row label="จำนวนบิล" value={`${billCount.toLocaleString("th-TH")} บิล`} />}
      <div className="border-t border-slate-100 my-1" />
      <div className="text-[9px] text-slate-400 text-center">ยอดสะสมจะสรุปอีกครั้งในใบประจำสัปดาห์/เดือน</div>
    </Shell>
  );
}

export function WeeklyCardPreview({ shop, sellerName, weekLabel, transferAmount, dayCount, vatRate, salesIncludesVat = false }: {
  shop: string; sellerName: string; weekLabel: string; transferAmount: number; dayCount: number; vatRate: number; salesIncludesVat?: boolean;
}) {
  const v = salesVat(transferAmount, vatRate, salesIncludesVat);
  return (
    <Shell title="สรุปยอดขายประจำสัปดาห์" subtitle={weekLabel}>
      <div className="text-[15px] font-bold text-slate-800 leading-tight">{shop}</div>
      <div className="text-[10px] text-slate-400">สรุปโดย: {sellerName} · รวม {dayCount} วัน</div>
      <div className="border-t border-slate-100 my-1" />
      <Row label="ยอดขายรวมสัปดาห์ (รวม VAT)" value={baht(v.total)} bold />
      <Row label="ยอดขายก่อนภาษี" value={baht(v.base)} />
      <Row label="VAT 7%" value={baht(v.vat)} />
      <div className="rounded-lg bg-emerald-50 px-3 py-2 mt-1">
        <div className="text-[11px] text-slate-500">ยอดวางบิลประจำสัปดาห์ (รวม VAT)</div>
        <div className="text-xl font-bold tabular-nums" style={{ color: "#0f6e56" }}>{baht(v.total)}</div>
      </div>
      <div className="text-[9px] text-slate-400 text-center pt-1">ส่วนแบ่งยอดขายจะเรียกเก็บอีกครั้งตอนสรุปสิ้นเดือน</div>
    </Shell>
  );
}

export function DrinkWelfareCardPreview({ shop, sellerName, periodLabel, count, total, vatRate, byTier, cashCount, cashTotal }: {
  shop: string; sellerName: string; periodLabel: string; count: number; total: number; vatRate: number;
  byTier: Array<{ amount: number; count: number; subtotal: number }>;
  cashCount: number; cashTotal: number;
}) {
  const v = salesVat(total, vatRate, true); // 50/80 already include VAT
  return (
    <Shell title="สวัสดิการเครื่องดื่มพนักงาน" subtitle={periodLabel}>
      <div className="text-[15px] font-bold text-slate-800 leading-tight">{shop}</div>
      <div className="text-[10px] text-slate-400">สรุปโดย: {sellerName} · หักเงินเดือน {count} แก้ว</div>
      <div className="border-t border-slate-100 my-1" />
      {byTier.map((t) => <Row key={t.amount} label={`฿${t.amount} × ${t.count} แก้ว`} value={baht(t.subtotal)} />)}
      <Row label="รวม (รวม VAT)" value={baht(v.total)} bold />
      <Row label="ก่อน VAT" value={baht(v.base)} />
      <Row label="VAT 7%" value={baht(v.vat)} />
      <div className="rounded-lg bg-emerald-50 px-3 py-2 mt-1">
        <div className="text-[11px] text-slate-500">ยอดที่บริษัทชำระคู่ค้า (รวม VAT)</div>
        <div className="text-xl font-bold tabular-nums" style={{ color: "#0f6e56" }}>{baht(v.total)}</div>
      </div>
      {cashCount > 0 && (
        <div className="text-[10px] text-slate-400 pt-1">จ่ายเอง (พนักงานจ่ายตรง · info): {cashCount} แก้ว · {baht(cashTotal)}</div>
      )}
      <div className="text-[9px] text-slate-400 text-center pt-1">อ่านจากการเบิกสิทธิ์ · ไม่คิด GP · คู่ค้าออกใบกำกับให้บริษัท</div>
    </Shell>
  );
}

/** Modal: shows a card preview + a PIN field, then sends on confirm. */
export function SendPreviewModal({ heading, preview, busy, onConfirm, onClose }: {
  heading: string;
  preview: React.ReactNode;
  busy: boolean;
  onConfirm: (pin: string) => Promise<{ ok: boolean; message?: string }>;
  onClose: () => void;
}) {
  return <SendPreviewInner heading={heading} preview={preview} busy={busy} onConfirm={onConfirm} onClose={onClose} />;
}

function SendPreviewInner({ heading, preview, busy, onConfirm, onClose }: {
  heading: string; preview: React.ReactNode; busy: boolean;
  onConfirm: (pin: string) => Promise<{ ok: boolean; message?: string }>; onClose: () => void;
}) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  async function submit() {
    if (!/^\d{4}$/.test(pin)) { setErr("PIN ต้องเป็นตัวเลข 4 หลัก"); return; }
    setSending(true); setErr(null);
    try {
      const r = await onConfirm(pin);
      if (!r.ok) setErr(r.message ?? "ส่งไม่สำเร็จ");
    } finally { setSending(false); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-y-auto" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5 space-y-3 my-8" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800">{heading}</h3>
        <p className="text-[11px] text-slate-400">ตัวอย่างข้อความที่คู่ค้าจะเห็นใน LINE</p>
        <div className="rounded-2xl bg-slate-100 p-3">{preview}</div>
        <div>
          <label className="label">PIN (4 หลัก) เพื่อยืนยันส่ง</label>
          <input type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={4} value={pin}
            onChange={(e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !sending) void submit(); }}
            className="input font-mono text-center text-2xl tracking-[10px]" />
        </div>
        {err && <p className="text-rose-600 text-xs font-medium">{err === "pin_invalid" || err === "wrong_pin" ? "✗ PIN ไม่ถูกต้อง" : `✗ ${err}`}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={sending || busy} className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium disabled:opacity-50">ยกเลิก</button>
          <button type="button" onClick={submit} disabled={sending || busy || pin.length < 4} className="flex-1 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-bold disabled:opacity-50">{sending ? "กำลังส่ง…" : "ยืนยันส่งเข้ากลุ่ม"}</button>
        </div>
      </div>
    </div>
  );
}
