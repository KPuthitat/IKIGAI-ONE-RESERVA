// /staff/persona/payslip — พนักงานเปิดดูสลิปเงินเดือนของตัวเอง (owner 2026-09-05).
// เห็นเฉพาะรอบที่ "ทำจ่ายแล้ว" เท่านั้น (owner 2026-09-05: สถานะอื่นไม่ต้องให้ดู —
// รอบร่าง/ยืนยันแล้ว ยอดยังปรับได้ก่อนจ่ายจริง).
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { formatLongDate } from "@/lib/time";
import { fmtMoney } from "@/lib/format";
import { paidBankPayslipMonths } from "@/lib/payslip-bank";
import EmptyState from "@/app/components/EmptyState";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สลิปเงินเดือนของฉัน · PERSONA" };

type Row = {
  period_id: number;
  period_start: string;
  period_end: string;
  pay_date: string;
  cycle: "weekly" | "monthly";
  status: "paid";
  net_pay: number;
  branch_name: string | null;
};

export default function StaffPayslipListPage() {
  const user = requireUser();
  const db = getDb();

  const rows = db.prepare(`
    SELECT p.id AS period_id, p.period_start, p.period_end, p.pay_date, p.cycle, p.status,
           l.net_pay, b.name AS branch_name
    FROM payroll_lines l
    JOIN payroll_periods p ON p.id = l.period_id
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE l.user_id = ? AND p.status = 'paid'
    ORDER BY p.period_start DESC, p.id DESC
  `).all(user.id) as Row[];

  const lang = getLang();
  const bankMonths = paidBankPayslipMonths(db, user.id);
  const TH = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const monthLabel = (ym: string) => { const [y, m] = ym.split("-").map(Number); return `${TH[m - 1]} ${y + 543}`; };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">สลิปเงินเดือนของฉัน</h1>
        <Link href="/staff/persona" className="text-sm text-brand hover:underline">← ลงเวลา</Link>
      </div>
      <p className="text-sm text-slate-500 -mt-2">
        เปิดดูรายละเอียดค่าตอบแทนแต่ละรอบ พร้อมวิธีคำนวณและตารางลงเวลารายวัน · แสดงเฉพาะรอบที่ทำจ่ายแล้ว
      </p>

      {bankMonths.length > 0 && (
        <div className="card">
          <div className="text-sm font-semibold text-slate-800">สลิป A4 สำหรับยื่นภายนอก (ธนาคาร ฯลฯ)</div>
          <p className="text-xs text-slate-500 mt-0.5">สลิปรายเดือนแบบทางการ พิมพ์หรือบันทึกเป็น PDF ได้ · เฉพาะเดือนที่จ่ายครบแล้ว</p>
          <div className="flex flex-wrap gap-2 mt-3">
            {bankMonths.slice(0, 12).map((ym) => (
              <Link key={ym} href={`/staff/persona/payslip/bank?m=${ym}`}
                className="text-xs rounded-md border border-brand/40 px-3 py-1.5 text-brand hover:bg-amber-50">
                {monthLabel(ym)}
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="card overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState className="border-0 shadow-none">ยังไม่มีสลิปที่เปิดดูได้</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">รอบจ่าย</th>
                <th className="py-2 pr-3">วันที่จ่าย</th>
                <th className="py-2 pr-3 text-right">ยอดสุทธิ</th>
                <th className="py-2 pr-3">สถานะ</th>
                <th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.period_id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800">
                      {formatLongDate(r.period_start, lang)} – {formatLongDate(r.period_end, lang)}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {r.cycle === "weekly" ? "รอบสัปดาห์" : "รอบเดือน"}{r.branch_name ? ` · ${r.branch_name}` : ""}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-slate-600 whitespace-nowrap">{formatLongDate(r.pay_date, lang)}</td>
                  <td className="py-2 pr-3 text-right font-semibold text-emerald-700 tabular-nums whitespace-nowrap">
                    ฿{fmtMoney(r.net_pay)}
                  </td>
                  <td className="py-2 pr-3">
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-100 text-emerald-700">
                      ทำจ่ายแล้ว
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <Link href={`/staff/persona/payslip/${r.period_id}`} className="text-xs text-brand hover:underline whitespace-nowrap">
                      เปิดสลิป →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
