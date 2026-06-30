"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";
import { fmtMoney, grpMoney, parseMoney } from "@/lib/format";
import { humanizeApiError } from "@/lib/error-messages";
import { splitVat, round2, DOC_TYPES, DOC_TYPE_LABEL } from "@/lib/accounta";
import Select from "@/app/components/Select";

type Initial = {
  doc_type: string | null; vendor_name: string | null; ocr_tax_id: string | null;
  category: string | null; amount_total: number; has_tax_invoice: boolean;
  vat_amount: number; bill_date: string; note: string | null;
};

export default function BillForm({
  token, branchName, categories, initial
}: {
  token: string;
  branchName: string | null;
  categories: Array<{ code: string | null; name: string }>;
  initial: Initial;
}) {
  const [docType, setDocType] = useState(initial.doc_type ?? "");
  const [vendor, setVendor] = useState(initial.vendor_name ?? "");
  const [taxId, setTaxId] = useState(initial.ocr_tax_id ?? "");
  const [category, setCategory] = useState(initial.category ?? "");
  const [amount, setAmount] = useState(initial.amount_total ? grpMoney(String(initial.amount_total)) : "");
  const [hasVat, setHasVat] = useState(initial.has_tax_invoice);
  const [vatManual, setVatManual] = useState(initial.vat_amount ? grpMoney(String(initial.vat_amount)) : "");
  const [note, setNote] = useState(initial.note ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const total = parseMoney(amount) || 0;
  // VAT: use the typed value if given, else derive 7% from the total.
  const vat = hasVat
    ? (vatManual.trim() !== "" ? round2(parseMoney(vatManual) || 0) : splitVat(round2(total), true).vat)
    : 0;

  async function submit() {
    if (!Number.isFinite(total) || total <= 0) { setErr("กรุณากรอกยอดรวมให้ถูกต้อง"); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/accounta/line-bill/submit"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token, doc_type: docType || null, vendor_name: vendor.trim() || null,
          ocr_tax_id: taxId.replace(/\D/g, "") || null, category: category || null,
          amount_total: round2(total), has_tax_invoice: hasVat, vat_amount: vat,
          note: note.trim() || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ส่งไม่สำเร็จ ลองอีกครั้ง")); return; }
      setDone(true);
    } catch {
      setErr("เชื่อมต่อไม่ได้ — ลองอีกครั้ง");
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 text-center space-y-2">
        <div className="text-3xl">✓</div>
        <div className="text-lg font-bold text-slate-800">ส่งให้แอดมินตรวจแล้ว</div>
        <p className="text-sm text-slate-500">ขอบคุณครับ — ปิดหน้านี้กลับไปที่ LINE ได้เลย</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="bg-slate-800 text-white px-5 py-4">
        <div className="text-[11px] text-white/70">IKIGAI OS · ACCOUNTA</div>
        <div className="text-lg font-bold">กรอกรายละเอียดบิล</div>
        {branchName && <div className="text-xs text-slate-300 mt-0.5">สาขา {branchName} · วันที่บิล {initial.bill_date}</div>}
      </div>
      <div className="p-5 space-y-4">
        <div>
          <label className="label !text-xs">ประเภทเอกสาร *</label>
          <Select value={docType} onChange={setDocType} placeholder="— เลือกประเภท —"
            options={DOC_TYPES.map((d) => ({ value: d, label: DOC_TYPE_LABEL[d] }))} />
        </div>

        <div>
          <label className="label !text-xs">ผู้จำหน่าย / ผู้รับเงิน</label>
          <input className="input" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="ชื่อร้าน/บริษัท" />
        </div>

        <div>
          <label className="label !text-xs">เลขผู้เสียภาษี (13 หลัก)</label>
          <input className="input" inputMode="numeric" value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder="เว้นว่างได้ถ้าไม่มี" />
        </div>

        <div>
          <label className="label !text-xs">หมวดหมู่</label>
          <Select value={category} onChange={setCategory} placeholder="— ให้แอดมินจัดหมวด —"
            options={categories.map((c) => ({ value: c.name, label: c.code ? `${c.code} · ${c.name}` : c.name }))} />
        </div>

        <div>
          <label className="label !text-xs">ยอดรวมของบิล (รวม VAT) *</label>
          <input type="text" inputMode="decimal" className="input text-right font-mono" value={amount} onChange={(e) => setAmount(grpMoney(e.target.value))} placeholder="0.00" />
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={hasVat} onChange={(e) => setHasVat(e.target.checked)} />
          มีภาษีมูลค่าเพิ่ม (VAT)
        </label>
        {hasVat && (
          <div>
            <label className="label !text-xs">ยอดภาษี (VAT) — เว้นว่างเพื่อคิด 7% ให้อัตโนมัติ</label>
            <input type="text" inputMode="decimal" className="input text-right font-mono" value={vatManual} onChange={(e) => setVatManual(grpMoney(e.target.value))} placeholder={fmtMoney(splitVat(round2(total), true).vat)} />
            <div className="text-[11px] text-slate-400 mt-1">ฐานภาษี ฿{fmtMoney(round2(total - vat))} · ภาษี ฿{fmtMoney(vat)}</div>
          </div>
        )}

        <div>
          <label className="label !text-xs">หมายเหตุ</label>
          <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="เพิ่มเติม (เว้นว่างได้)" />
        </div>

        {err && <div className="text-sm text-rose-600">{err}</div>}

        <button type="button" onClick={submit} disabled={busy}
          className="w-full rounded-md bg-brand text-white py-2.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50">
          {busy ? "กำลังส่ง…" : "ส่งให้แอดมินตรวจ"}
        </button>
        <p className="text-[11px] text-slate-400 text-center">บิลจะรอแอดมินของสาขาตรวจสอบก่อนบันทึกเข้าระบบ</p>
      </div>
    </div>
  );
}
