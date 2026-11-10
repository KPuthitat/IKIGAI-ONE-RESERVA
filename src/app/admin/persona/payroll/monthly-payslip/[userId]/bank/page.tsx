// A4 monthly payslip for EXTERNAL use (bank loan / visa / credit-card applications).
// Formal single-page certificate: company identity, employee, income / deductions /
// net, receiving account, document number and signature + company-seal boxes.
// Every figure comes from monthlyPayrollRollup — the same data set as the internal
// monthly slip and the summary page — so it can never disagree with the books.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fmtMoney } from "@/lib/format";
import { nameWithPrefix } from "@/lib/name";
import { bahtText } from "@/lib/bahttext";
import { monthlyPayrollRollup } from "@/lib/payroll-month";
import PayslipPrintButton from "../../../[id]/payslip/[userId]/PayslipPrintButton";
import { getLang } from "@/lib/lang-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สลิปเงินเดือน A4 (สำหรับยื่นภายนอก) · PERSONA" };

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const round2 = (n: number) => Math.round(n * 100) / 100;

function bkkToday(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}
function thaiDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}

export default function BankPayslipPage({
  params, searchParams
}: { params: { userId: string }; searchParams: { m?: string } }) {
  requirePayrollAccess();
  const lang = getLang();
  const db = getDb();

  const userId = Number(params.userId);
  if (!Number.isInteger(userId)) notFound();
  const month = /^\d{4}-\d{2}$/.test(searchParams.m ?? "") ? searchParams.m! : bkkToday().slice(0, 7);

  const rollup = monthlyPayrollRollup(db, month);
  const mine = rollup.people.filter((p) => p.userId === userId);
  if (mine.length === 0) notFound();

  const profile = db.prepare(
    "SELECT display_name, title_prefix, employee_code, bank_name, bank_account FROM users WHERE id = ?"
  ).get(userId) as { display_name: string; title_prefix: string | null; employee_code: string | null; bank_name: string | null; bank_account: string | null } | undefined;
  if (!profile) notFound();

  const sum = (f: (p: (typeof mine)[number]) => number) => round2(mine.reduce((a, p) => a + f(p), 0));
  const wage = sum((p) => p.comp);
  const svc = round2(sum((p) => p.svcGross) + sum((p) => p.mtgGross) + sum((p) => p.dutyGross));
  const income = sum((p) => p.income);
  const sso = sum((p) => p.sso);
  const tax = sum((p) => p.tax);
  const gi = sum((p) => p.gi);
  const other = round2(sum((p) => p.ded) - sso - tax - gi);
  const ded = sum((p) => p.ded);
  const net = sum((p) => p.take);

  // The paying company = the one that paid this person the most this month.
  const main = [...mine].sort((a, b) => b.income - a.income)[0];
  const company = main.companyId != null
    ? (db.prepare("SELECT name_th, tax_id, address, phone FROM companies WHERE id = ?")
        .get(main.companyId) as { name_th: string; tax_id: string | null; address: string | null; phone: string | null } | undefined)
    : undefined;

  // Pay dates + whether every round has actually been paid (a draft slip must not
  // be handed to a bank as proof of income).
  const rounds = db.prepare(`
    SELECT pp.pay_date, pp.status FROM payroll_lines pl JOIN payroll_periods pp ON pp.id = pl.period_id
    WHERE pl.user_id = ? AND pp.pay_date >= ? AND pp.pay_date <= ? AND pp.branch_id IS NOT NULL AND pp.status != 'cancelled'
    ORDER BY pp.pay_date
  `).all(userId, `${month}-01`, `${month}-31`) as Array<{ pay_date: string; status: string }>;
  const allPaid = rounds.length > 0 && rounds.every((r) => r.status === "paid");
  const lastPay = rounds.length ? rounds[rounds.length - 1].pay_date : null;

  const [y, m] = month.split("-").map(Number);
  const monthText = `${TH_MONTHS[m - 1]} ${y + 543}`;
  const docNo = `PS-${month.replace("-", "")}-${(profile.employee_code ?? String(userId)).replace(/\s+/g, "")}`;
  const issued = bkkToday();
  const name = nameWithPrefix(profile.title_prefix, profile.display_name);
  const empType = main.employmentType === "ft" ? "พนักงานประจำ" : main.employmentType === "pt" ? "พนักงานรายชั่วโมง (พาร์ทไทม์)" : "—";

  const incomeRows: Array<[string, number]> = [];
  if (wage > 0) incomeRows.push(["ค่าตอบแทน / เงินเดือน (รวมค่าล่วงเวลาและรายได้อื่น)", wage]);
  if (svc > 0) incomeRows.push(["เซอร์วิสชาร์จ / เบี้ยประชุม / ค่าตอบแทนพิเศษ", svc]);
  const dedRows: Array<[string, number]> = [];
  if (sso > 0) dedRows.push(["ประกันสังคม", sso]);
  if (tax > 0) dedRows.push(["ภาษีหัก ณ ที่จ่าย", tax]);
  if (gi > 0) dedRows.push(["เบี้ยประกันกลุ่ม", gi]);
  if (other > 0) dedRows.push(["รายการหักอื่น ๆ", other]);

  return (
    <>
      <div className="space-y-3 print:hidden">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href={`/admin/persona/payroll/summary?m=${month}`} className="text-sm text-slate-500 hover:text-brand">← สรุปเงินเดือน</Link>
          <Link href={`/admin/persona/payroll/monthly-payslip/${userId}?m=${month}`} className="text-sm text-brand hover:underline">สลิปภายใน (มีรายละเอียดรายวัน)</Link>
          <PayslipPrintButton lang={lang} />
        </div>
        {!allPaid && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            เดือนนี้ยังมีรอบที่ไม่ได้อยู่ในสถานะ “จ่ายแล้ว” — ตัวเลขอาจยังเปลี่ยนได้ ควรรอให้จ่ายครบก่อนนำไปยื่นภายนอก
          </div>
        )}
        <div className="text-xs text-slate-500">ตอนพิมพ์ให้เลือกกระดาษ A4 แนวตั้ง และปิด “หัวกระดาษ/ท้ายกระดาษ” ของเบราว์เซอร์ หรือเลือกบันทึกเป็น PDF</div>
      </div>

      <div className="payslip mx-auto bg-white text-slate-900 shadow-card mt-3 print:shadow-none w-full max-w-[210mm] min-h-[297mm] p-[16mm] print:p-0 flex flex-col text-[13px] leading-relaxed">
        {/* Letterhead */}
        <div className="flex items-start justify-between gap-6 border-b-2 border-slate-800 pb-3">
          <div>
            <div className="text-xl font-bold">{company?.name_th ?? "IKIGAI MEDIHEALTH"}</div>
            {company?.address && <div className="text-xs text-slate-600 whitespace-pre-line mt-0.5">{company.address}</div>}
            <div className="text-xs text-slate-600 mt-0.5">
              {company?.tax_id ? `เลขประจำตัวผู้เสียภาษี ${company.tax_id}` : ""}
              {company?.phone ? `${company?.tax_id ? "  ·  " : ""}โทร ${company.phone}` : ""}
            </div>
          </div>
          <div className="text-right text-xs text-slate-600 shrink-0">
            <div>เลขที่เอกสาร <b className="text-slate-800">{docNo}</b></div>
            <div>วันที่ออกเอกสาร {thaiDate(issued)}</div>
          </div>
        </div>

        <div className="text-center my-5">
          <h1 className="text-xl font-bold tracking-wide">ใบแจ้งรายได้ประจำเดือน</h1>
          <div className="text-xs text-slate-500">PAYSLIP</div>
          <div className="text-sm mt-1">ประจำเดือน {monthText}</div>
        </div>

        {/* Employee */}
        <table className="w-full border border-slate-400 mb-4">
          <tbody>
            <tr>
              <td className="border border-slate-300 bg-slate-50 px-3 py-1.5 w-[22%]">ชื่อ-สกุล</td>
              <td className="border border-slate-300 px-3 py-1.5 font-medium">{name}</td>
              <td className="border border-slate-300 bg-slate-50 px-3 py-1.5 w-[18%]">รหัสพนักงาน</td>
              <td className="border border-slate-300 px-3 py-1.5">{profile.employee_code ?? "—"}</td>
            </tr>
            <tr>
              <td className="border border-slate-300 bg-slate-50 px-3 py-1.5">ประเภทการจ้าง</td>
              <td className="border border-slate-300 px-3 py-1.5">{empType}</td>
              <td className="border border-slate-300 bg-slate-50 px-3 py-1.5">วันที่จ่ายเงิน</td>
              <td className="border border-slate-300 px-3 py-1.5">{lastPay ? thaiDate(lastPay) : "—"}</td>
            </tr>
            <tr>
              <td className="border border-slate-300 bg-slate-50 px-3 py-1.5">บัญชีรับเงิน</td>
              <td className="border border-slate-300 px-3 py-1.5" colSpan={3}>
                {profile.bank_name && profile.bank_account ? `${profile.bank_name}  เลขที่ ${profile.bank_account}` : "—"}
              </td>
            </tr>
          </tbody>
        </table>

        {/* Income / deductions */}
        <div className="grid grid-cols-2 gap-4">
          <table className="w-full border border-slate-400 self-start">
            <thead>
              <tr className="bg-slate-100"><th className="border border-slate-300 px-3 py-1.5 text-left">รายได้ (Earnings)</th><th className="border border-slate-300 px-3 py-1.5 text-right w-28">บาท</th></tr>
            </thead>
            <tbody>
              {incomeRows.map(([l, v]) => (
                <tr key={l}><td className="border border-slate-300 px-3 py-1.5">{l}</td><td className="border border-slate-300 px-3 py-1.5 text-right tabular-nums">{fmtMoney(v)}</td></tr>
              ))}
              {incomeRows.length === 0 && <tr><td className="border border-slate-300 px-3 py-1.5 text-slate-400" colSpan={2}>—</td></tr>}
              <tr className="font-bold bg-slate-50"><td className="border border-slate-300 px-3 py-1.5">รวมรายได้</td><td className="border border-slate-300 px-3 py-1.5 text-right tabular-nums">{fmtMoney(income)}</td></tr>
            </tbody>
          </table>
          <table className="w-full border border-slate-400 self-start">
            <thead>
              <tr className="bg-slate-100"><th className="border border-slate-300 px-3 py-1.5 text-left">รายการหัก (Deductions)</th><th className="border border-slate-300 px-3 py-1.5 text-right w-28">บาท</th></tr>
            </thead>
            <tbody>
              {dedRows.map(([l, v]) => (
                <tr key={l}><td className="border border-slate-300 px-3 py-1.5">{l}</td><td className="border border-slate-300 px-3 py-1.5 text-right tabular-nums">{fmtMoney(v)}</td></tr>
              ))}
              {dedRows.length === 0 && <tr><td className="border border-slate-300 px-3 py-1.5 text-slate-400" colSpan={2}>ไม่มีรายการหัก</td></tr>}
              <tr className="font-bold bg-slate-50"><td className="border border-slate-300 px-3 py-1.5">รวมรายการหัก</td><td className="border border-slate-300 px-3 py-1.5 text-right tabular-nums">{fmtMoney(ded)}</td></tr>
            </tbody>
          </table>
        </div>

        {/* Net */}
        <div className="mt-4 border-2 border-slate-800 px-4 py-3">
          <div className="flex items-baseline justify-between">
            <span className="font-bold">เงินได้สุทธิ (Net Pay)</span>
            <span className="text-2xl font-bold tabular-nums">{fmtMoney(net)} <span className="text-sm font-normal">บาท</span></span>
          </div>
          <div className="text-xs text-slate-600 mt-1">({bahtText(net)})</div>
        </div>

        <p className="mt-4 text-xs text-slate-600">
          บริษัทขอรับรองว่าข้อมูลข้างต้นเป็นความจริง และออกให้เพื่อใช้เป็นหลักฐานแสดงรายได้ของพนักงานตามที่ระบุเท่านั้น
          {allPaid ? "" : " (ข้อมูลระหว่างรอการจ่ายเงินครบทุกรอบ)"}
        </p>

        {/* Signatures */}
        <div className="mt-auto pt-10 grid grid-cols-2 gap-10 text-center text-xs">
          <div>
            <div className="h-20 border-b border-slate-500" />
            <div className="mt-1">ผู้มีอำนาจลงนาม / ฝ่ายบุคคล</div>
            <div className="text-slate-500">วันที่ ........ / ........ / ........</div>
          </div>
          <div>
            <div className="h-20 border border-dashed border-slate-400 flex items-center justify-center text-slate-400">ตราประทับบริษัท</div>
            <div className="mt-1 text-slate-500">(ถ้ามี)</div>
          </div>
        </div>
        <div className="mt-6 text-center text-[10px] text-slate-400">
          เอกสารฉบับนี้ออกจากระบบ NOKHOOK OS · เลขที่ {docNo}
        </div>
      </div>
    </>
  );
}
