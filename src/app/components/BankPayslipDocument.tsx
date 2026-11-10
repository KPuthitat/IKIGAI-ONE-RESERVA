import { fmtMoney } from "@/lib/format";
import { bahtText } from "@/lib/bahttext";
import { thaiDate, type BankPayslip } from "@/lib/payslip-bank";

// Formal one-page A4 payslip (presentational). Used by the admin and staff pages.
export default function BankPayslipDocument({ d }: { d: BankPayslip }) {
  const { company, docNo, issued, monthText, name, empType, lastPay, incomeRows, dedRows, income, ded, net, allPaid } = d;
  const profile = { employee_code: d.employeeCode, bank_name: d.bankName, bank_account: d.bankAccount };
  return (
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
  );
}
