import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { formatLongDate } from "@/lib/time";
import { fmtMoney } from "@/lib/format";
import { nameWithPrefix } from "@/lib/name";
import SummaryPrintButton from "./SummaryPrintButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สรุปค่าตอบแทนทั้งรอบ · PERSONA" };

// Whole-period compensation summary (owner 2026-06-18): one printable sheet
// listing every employee in the pay run with their earnings/deductions/net +
// a totals row — for sending to the accounting office as a PDF. Print is the
// browser's "save as PDF" (window.print), same as the single payslip.

type Period = {
  id: number;
  cycle: "weekly" | "monthly";
  target: "pt" | "ft" | "all";
  period_start: string;
  period_end: string;
  pay_date: string;
  status: "draft" | "finalized" | "paid" | "cancelled";
};

type Line = {
  user_id: number;
  employee_code: string | null;
  display_name: string;
  title_prefix: string | null;
  employment_type: "pt" | "ft" | null;
  bank_name: string | null;
  bank_account: string | null;
  days_worked: number;
  base_pay: number;
  ot_pay: number;
  service_charge: number;
  other_additions: number;
  gross_pay: number;
  sso_amount: number;
  tax_amount: number;
  other_deductions: number;
  net_pay: number;
};

const STATUS_TH: Record<Period["status"], string> = {
  draft: "ฉบับร่าง", finalized: "ยืนยันแล้ว", paid: "จ่ายแล้ว", cancelled: "ยกเลิก"
};

function maskAccount(acc: string | null): string {
  if (!acc) return "—";
  const digits = acc.replace(/\D/g, "");
  if (digits.length < 8) return acc;
  return `${digits.slice(0, 3)}-x-xxxxx-${digits.slice(-1)}`;
}

export default function PayrollSummaryPage({ params }: { params: { id: string } }) {
  requirePayrollAccess();
  const lang = getLang();
  const db = getDb();

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const period = db.prepare(`
    SELECT id, cycle, target, period_start, period_end, pay_date, status
    FROM payroll_periods WHERE id = ?
  `).get(id) as Period | undefined;
  if (!period) notFound();

  const lines = db.prepare(`
    SELECT pl.user_id, pl.employee_code, pl.display_name, u.title_prefix, pl.employment_type,
           u.bank_name, u.bank_account,
           pl.days_worked, pl.base_pay, pl.ot_pay, pl.service_charge, pl.other_additions,
           pl.gross_pay, pl.sso_amount, pl.tax_amount, pl.other_deductions, pl.net_pay
    FROM payroll_lines pl
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pl.period_id = ?
    ORDER BY CASE WHEN pl.employment_type = 'ft' THEN 0 WHEN pl.employment_type = 'pt' THEN 1 ELSE 2 END,
             pl.display_name
  `).all(id) as Line[];

  // Company on the letterhead = the one the run's employees belong to, via
  // their branch (owner 2026-06-18: หัวกระดาษต้องตรงสังกัดพนักงาน). Pick the
  // company shared by the most employees; fall back to the default company.
  type Company = { name_th: string; name_en: string | null; tax_id: string | null; address: string | null; phone: string | null };
  let company = db.prepare(`
    SELECT c.name_th, c.name_en, c.tax_id, c.address, c.phone
    FROM payroll_lines pl
    JOIN user_branches ub ON ub.user_id = pl.user_id
    JOIN branches b ON b.id = ub.branch_id
    JOIN companies c ON c.id = b.company_id
    WHERE pl.period_id = ?
    GROUP BY c.id
    ORDER BY COUNT(*) DESC, c.id ASC
    LIMIT 1
  `).get(id) as Company | undefined;
  if (!company) {
    company = db.prepare(
      "SELECT name_th, name_en, tax_id, address, phone FROM companies WHERE active = 1 ORDER BY id LIMIT 1"
    ).get() as Company | undefined;
  }
  // How many distinct companies are represented — if >1 the single letterhead
  // is only the dominant one, so we note it.
  const companyCount = (db.prepare(`
    SELECT COUNT(DISTINCT b.company_id) AS n
    FROM payroll_lines pl
    JOIN user_branches ub ON ub.user_id = pl.user_id
    JOIN branches b ON b.id = ub.branch_id
    WHERE pl.period_id = ? AND b.company_id IS NOT NULL
  `).get(id) as { n: number }).n;

  // Tax establishment (สาขา) the run's employees belong to — owner 2026-06-18:
  // "สาขานามะ มัน 00001". Head office = 00000 = สำนักงานใหญ่; others = สาขาที่ X.
  type RunBranch = { name: string; tax_branch_code: string | null; reg_address: string | null };
  const branch = db.prepare(`
    SELECT b.name, b.tax_branch_code, b.reg_address
    FROM payroll_lines pl
    JOIN user_branches ub ON ub.user_id = pl.user_id
    JOIN branches b ON b.id = ub.branch_id
    WHERE pl.period_id = ?
    GROUP BY b.id
    ORDER BY COUNT(*) DESC, b.id ASC
    LIMIT 1
  `).get(id) as RunBranch | undefined;
  const branchCount = (db.prepare(`
    SELECT COUNT(DISTINCT ub.branch_id) AS n
    FROM payroll_lines pl JOIN user_branches ub ON ub.user_id = pl.user_id
    WHERE pl.period_id = ?
  `).get(id) as { n: number }).n;

  const branchTaxLabel = (code: string | null): string => {
    const c = (code ?? "").trim();
    return !c || c === "00000" ? "สำนักงานใหญ่ (00000)" : `สาขาที่ ${c}`;
  };
  // The establishment address (สาขา) is more accurate for the doc than the HQ;
  // fall back to the company's registered address when the branch has none.
  const addressToShow = branch?.reg_address?.trim() || company?.address || null;

  // Column totals — summed in code so the printed footer ties out exactly to
  // the rows above (never recomputed from rounded display strings).
  const tot = lines.reduce((a, l) => ({
    base: a.base + l.base_pay, ot: a.ot + l.ot_pay, svc: a.svc + l.service_charge,
    add: a.add + l.other_additions, gross: a.gross + l.gross_pay,
    sso: a.sso + l.sso_amount, tax: a.tax + l.tax_amount, ded: a.ded + l.other_deductions,
    net: a.net + l.net_pay
  }), { base: 0, ot: 0, svc: 0, add: 0, gross: 0, sso: 0, tax: 0, ded: 0, net: 0 });
  const totalDeductions = tot.sso + tot.tax + tot.ded;

  return (
    <>
      {/* Landscape for the wide table when printed. */}
      <style dangerouslySetInnerHTML={{ __html: "@media print{@page{size:A4 landscape;margin:10mm}}" }} />

      {/* On-screen toolbar — hidden on paper */}
      <div className="flex items-center gap-3 flex-wrap no-print mb-3">
        <Link href={`/admin/persona/payroll/${id}`} className="text-sm text-slate-500 hover:text-brand">
          ← กลับรอบค่าตอบแทน
        </Link>
        <SummaryPrintButton />
      </div>

      <div className="printable bg-white text-slate-800 p-6 rounded-2xl shadow-card print:shadow-none print:rounded-none">
        {/* Header — company + branch (สาขา) letterhead matching the employees */}
        <div className="text-center border-b-2 border-slate-300 pb-3 mb-3">
          <div className="text-xl font-bold tracking-wide">{company?.name_th ?? "IKIGAI MEDIHEALTH"}</div>
          {company?.name_en && <div className="text-xs text-slate-500 mt-0.5">{company.name_en}</div>}
          {branch && (
            <div className="text-[11px] text-slate-600 mt-0.5">
              <b>{branch.name}</b> · {branchTaxLabel(branch.tax_branch_code)}
            </div>
          )}
          {addressToShow && <div className="text-[11px] text-slate-500 mt-0.5 whitespace-pre-line">{addressToShow}</div>}
          {(company?.tax_id || company?.phone) && (
            <div className="text-[11px] text-slate-500">
              {company?.tax_id ? `เลขประจำตัวผู้เสียภาษี ${company.tax_id}` : ""}
              {company?.tax_id && company?.phone ? " · " : ""}
              {company?.phone ? `โทร ${company.phone}` : ""}
            </div>
          )}
          <h1 className="text-lg font-semibold mt-2">สรุปค่าตอบแทนทั้งรอบ (สำหรับสำนักงานบัญชี)</h1>
          {(companyCount > 1 || branchCount > 1) && (
            <div className="text-[10px] text-amber-600 mt-0.5">
              * รอบนี้มีพนักงานหลาย{companyCount > 1 ? "บริษัท" : "สาขา"} — หัวกระดาษแสดง{companyCount > 1 ? "บริษัท" : "สาขา"}หลัก
            </div>
          )}
        </div>

        {/* Period meta */}
        <div className="flex flex-wrap gap-x-8 gap-y-1 text-xs mb-3">
          <span><span className="text-slate-500">รอบ:</span> <b>{formatLongDate(period.period_start, lang)} – {formatLongDate(period.period_end, lang)}</b></span>
          <span><span className="text-slate-500">วันจ่าย:</span> <b>{formatLongDate(period.pay_date, lang)}</b></span>
          <span><span className="text-slate-500">รอบจ่าย:</span> <b>{period.cycle === "weekly" ? "รายสัปดาห์" : "รายเดือน"}</b></span>
          <span><span className="text-slate-500">สถานะ:</span> <b>{STATUS_TH[period.status]}</b></span>
          <span><span className="text-slate-500">จำนวนพนักงาน:</span> <b>{lines.length} คน</b></span>
        </div>

        {lines.length === 0 ? (
          <p className="text-sm text-slate-500 py-8 text-center">ยังไม่มีพนักงานในรอบนี้</p>
        ) : (
          <table className="w-full text-[10px] border-collapse">
            <thead>
              <tr className="bg-slate-100 text-slate-600">
                <Th className="text-left">#</Th>
                <Th className="text-left">ชื่อ-สกุล (รหัส)</Th>
                <Th>ประเภท</Th>
                <Th className="text-right">วันทำงาน</Th>
                <Th className="text-right">ค่าจ้าง/เงินเดือน</Th>
                <Th className="text-right">OT</Th>
                <Th className="text-right">เซอร์วิส</Th>
                <Th className="text-right">รายได้อื่น</Th>
                <Th className="text-right">รวมรายได้</Th>
                <Th className="text-right">ประกันสังคม</Th>
                <Th className="text-right">ภาษีหัก ณ ที่จ่าย</Th>
                <Th className="text-right">หักอื่นๆ</Th>
                <Th className="text-right">สุทธิ</Th>
                <Th className="text-left">ธนาคาร/บัญชี</Th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.user_id} className="border-b border-slate-100">
                  <Td className="text-left text-slate-500">{i + 1}</Td>
                  <Td className="text-left">
                    {nameWithPrefix(l.title_prefix, l.display_name)}
                    {l.employee_code ? <span className="text-slate-400"> ({l.employee_code})</span> : null}
                  </Td>
                  <Td className="text-center text-slate-500">{l.employment_type === "ft" ? "ประจำ" : l.employment_type === "pt" ? "พาร์ทไทม์" : "—"}</Td>
                  <Td className="text-right">{l.days_worked}</Td>
                  <Money v={l.base_pay} />
                  <Money v={l.ot_pay} />
                  <Money v={l.service_charge} />
                  <Money v={l.other_additions} />
                  <Money v={l.gross_pay} bold />
                  <Money v={l.sso_amount} />
                  <Money v={l.tax_amount} />
                  <Money v={l.other_deductions} />
                  <Money v={l.net_pay} bold />
                  <Td className="text-left text-slate-500">
                    {l.bank_name ? `${l.bank_name} ${maskAccount(l.bank_account)}` : "—"}
                  </Td>
                </tr>
              ))}
              {/* Totals */}
              <tr className="bg-slate-50 font-bold border-t-2 border-slate-400">
                <Td className="text-left" />
                <Td className="text-left">รวมทั้งสิ้น ({lines.length} คน)</Td>
                <Td />
                <Td />
                <Money v={tot.base} bold />
                <Money v={tot.ot} bold />
                <Money v={tot.svc} bold />
                <Money v={tot.add} bold />
                <Money v={tot.gross} bold />
                <Money v={tot.sso} bold />
                <Money v={tot.tax} bold />
                <Money v={tot.ded} bold />
                <Money v={tot.net} bold />
                <Td />
              </tr>
            </tbody>
          </table>
        )}

        {/* Bottom totals callout + signatures */}
        <div className="flex flex-wrap justify-between items-end gap-6 mt-5">
          <div className="text-xs text-slate-600 space-y-0.5">
            <div>รวมรายได้ (Gross): <b>฿{fmtMoney(tot.gross)}</b></div>
            <div>รวมรายการหัก: <b>฿{fmtMoney(totalDeductions)}</b> (ประกันสังคม ฿{fmtMoney(tot.sso)} · ภาษี ฿{fmtMoney(tot.tax)} · อื่นๆ ฿{fmtMoney(tot.ded)})</div>
            <div className="text-sm">ยอดจ่ายสุทธิทั้งรอบ: <b>฿{fmtMoney(tot.net)}</b></div>
          </div>
          <div className="grid grid-cols-2 gap-10 text-xs">
            <div>
              <div className="border-b border-slate-400 h-7 w-40"></div>
              <div className="text-center mt-1 text-slate-500">ผู้จัดทำ</div>
            </div>
            <div>
              <div className="border-b border-slate-400 h-7 w-40"></div>
              <div className="text-center mt-1 text-slate-500">ผู้อนุมัติ</div>
            </div>
          </div>
        </div>

        <div className="mt-4 text-center text-[9px] text-slate-400">
          เอกสารสรุปภายในเพื่อการจัดทำบัญชี — เลขบัญชีธนาคารถูกปิดบางส่วนเพื่อความปลอดภัย
        </div>
      </div>
    </>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <th className={`border border-slate-200 px-1.5 py-1 font-semibold ${className || "text-center"}`}>{children}</th>;
}
function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <td className={`border border-slate-100 px-1.5 py-1 ${className || "text-center"}`}>{children}</td>;
}
function Money({ v, bold }: { v: number; bold?: boolean }) {
  return (
    <td className={`border border-slate-100 px-1.5 py-1 text-right font-mono tabular-nums ${bold ? "font-bold" : ""}`}>
      {v ? fmtMoney(v) : "—"}
    </td>
  );
}
