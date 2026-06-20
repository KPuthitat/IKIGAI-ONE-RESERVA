import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getExpense } from "@/lib/accounta-db";
import { fmtMoney } from "@/lib/format";
import { formatLongDate } from "@/lib/time";
import { bahtText } from "@/lib/bahttext";
import PrintButton from "./PrintButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ใบรับรองแทนใบเสร็จรับเงิน · ACCOUNTA" };

// ใบรับรองแทนใบเสร็จรับเงิน (owner 2026-06-20, paypers-like #3.2).
// When a bill can't be backed by a proper receipt/tax invoice, print this
// company-letterhead certificate as the expense evidence. Browser
// "save as PDF" (window.print) — same mechanism as the payslip; the global
// @media print rule shows only the `.printable` region.
export default function SubstituteReceiptPage({ params }: { params: { id: string } }) {
  requirePermission("accounta.manage");
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const exp = getExpense(id);
  if (!exp) notFound();

  const db = getDb();
  const company = exp.company_id
    ? (db.prepare("SELECT name_th, tax_id, address FROM companies WHERE id = ?").get(exp.company_id) as
        { name_th: string; tax_id: string | null; address: string | null } | undefined)
    : undefined;
  const branch = exp.branch_id
    ? (db.prepare("SELECT name FROM branches WHERE id = ?").get(exp.branch_id) as { name: string } | undefined)
    : undefined;

  const vendor = exp.vendor_name || "—";
  const desc = exp.description || exp.vendor_name || "ค่าใช้จ่าย";
  const amount = exp.amount_total;
  const dateLabel = formatLongDate(exp.bill_date, "th");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap no-print">
        <Link href="/admin/accounta/expenses" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ รายจ่าย
        </Link>
        <PrintButton />
      </div>

      <div className="printable mx-auto bg-white text-slate-900" style={{ maxWidth: "190mm", padding: "12mm 14mm" }}>
        {/* Letterhead */}
        <div className="text-center border-b-2 border-slate-800 pb-3 mb-5">
          <div className="text-xl font-bold">{company?.name_th ?? "บริษัท"}</div>
          {company?.address && <div className="text-xs mt-1">{company.address}</div>}
          <div className="text-xs mt-0.5">
            {company?.tax_id ? `เลขประจำตัวผู้เสียภาษี ${company.tax_id}` : ""}
            {branch?.name ? `${company?.tax_id ? "  ·  " : ""}สาขา ${branch.name}` : ""}
          </div>
        </div>

        <h1 className="text-center text-lg font-bold mb-1">ใบรับรองแทนใบเสร็จรับเงิน</h1>
        <div className="text-right text-sm mb-4">วันที่ {dateLabel}</div>

        {/* Line-item table */}
        <table className="w-full text-sm border border-slate-400 border-collapse mb-3">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-400 px-2 py-1.5 w-12 text-center">ลำดับ</th>
              <th className="border border-slate-400 px-2 py-1.5 text-left">รายการ</th>
              <th className="border border-slate-400 px-2 py-1.5 w-32 text-right">จำนวนเงิน (บาท)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-slate-400 px-2 py-2 text-center align-top">1</td>
              <td className="border border-slate-400 px-2 py-2 align-top">
                {desc}
                <div className="text-xs text-slate-500 mt-0.5">ผู้รับเงิน: {vendor}</div>
              </td>
              <td className="border border-slate-400 px-2 py-2 text-right align-top font-medium">{fmtMoney(amount)}</td>
            </tr>
            {/* filler rows for a tidy sheet */}
            {[0, 1, 2].map((k) => (
              <tr key={k}><td className="border border-slate-400 px-2 py-2">&nbsp;</td><td className="border border-slate-400" /><td className="border border-slate-400" /></tr>
            ))}
            <tr className="font-bold">
              <td className="border border-slate-400 px-2 py-1.5 text-right" colSpan={2}>รวมเป็นเงิน</td>
              <td className="border border-slate-400 px-2 py-1.5 text-right">{fmtMoney(amount)}</td>
            </tr>
          </tbody>
        </table>
        <div className="text-sm mb-6">( ตัวอักษร: <b>{bahtText(amount)}</b> )</div>

        {/* Certification */}
        <p className="text-sm leading-7 mb-10" style={{ textIndent: "2.5em" }}>
          ข้าพเจ้าขอรับรองว่าได้จ่ายเงินค่า <u>&nbsp;{desc}&nbsp;</u> ให้แก่ <u>&nbsp;{vendor}&nbsp;</u>
          เป็นเงิน <u>&nbsp;{fmtMoney(amount)}&nbsp;</u> บาท ({bahtText(amount)}) เมื่อวันที่ {dateLabel} ไปจริง
          และไม่สามารถเรียกใบเสร็จรับเงิน/ใบกำกับภาษีจากผู้รับเงินได้ จึงขอรับรองไว้เป็นหลักฐาน
        </p>

        {/* Signatures */}
        <div className="grid grid-cols-2 gap-10 mt-12 text-center text-sm">
          <div>
            <div className="border-b border-slate-500 mb-1">&nbsp;</div>
            ลงชื่อ ผู้จ่ายเงิน
            <div className="text-xs text-slate-500 mt-1">( ............................................. )</div>
          </div>
          <div>
            <div className="border-b border-slate-500 mb-1">&nbsp;</div>
            ลงชื่อ ผู้อนุมัติ
            <div className="text-xs text-slate-500 mt-1">( ............................................. )</div>
          </div>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: "@media print{@page{size:A4 portrait;margin:0}}" }} />
    </div>
  );
}
