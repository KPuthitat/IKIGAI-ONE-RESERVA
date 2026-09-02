import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { companyFinancialYear, type CompanyFinancialYear, companyOverviewMonth } from "@/lib/accounta-db";
import { fmtMoney } from "@/lib/format";
import { TH_MONTHS_FULL } from "@/lib/revshare";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · ภาพรวมบริษัท (รวมสาขา)" };

function todayBkk(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

const TH_MON_ABBR = [
  "", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."
];

// ภาพรวมบริษัท (รวมทุกสาขา) — owner 2026-07-19: VAT (ภพ.30) รายเดือนยื่นรวม +
// ยอดขายรวมสองสาขา + ประมาณการภาษีเงินได้นิติบุคคลสิ้นปี. บริษัท = บริษัทของสาขา
// ที่เลือกอยู่ (activeBranchId → branches.company_id). ปีเลือกได้ผ่าน ?year=.
function thMonthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${TH_MON_ABBR[m]} ${y + 543}`;
}
// "YYYY-MM-DD" → "22 สิงหาคม" (day + full Thai month, no year).
function thDayLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${d} ${TH_MONTHS_FULL[m]}`;
}
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
// Delta vs previous month → colored pill. `goodUp` decides which direction is
// "good" (sales up = green; expense up = red).
function Delta({ now, prev, goodUp = true }: { now: number; prev: number; goodUp?: boolean }) {
  if (prev === 0) return null;
  const pct = Math.round(((now - prev) / Math.abs(prev)) * 100);
  if (pct === 0) return <span className="text-[11px] text-slate-400">เท่าเดือนก่อน</span>;
  const up = pct > 0;
  const good = up === goodUp;
  return (
    <span className={`text-[11px] font-medium ${good ? "text-emerald-600" : "text-rose-600"}`}>
      {up ? "▲" : "▼"} {Math.abs(pct)}% <span className="text-slate-400">vs เดือนก่อน</span>
    </span>
  );
}

export default function CompanyOverviewPage({
  searchParams
}: { searchParams: { year?: string; month?: string } }) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;

  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }

  const db = getDb();
  const branch = db.prepare("SELECT company_id FROM branches WHERE id = ?").get(branchId) as { company_id: number | null } | undefined;
  const companyId = branch?.company_id ?? null;

  if (companyId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <div className="card text-sm text-slate-500">สาขานี้ยังไม่ได้ผูกกับบริษัท — ตั้งค่าบริษัทให้สาขาก่อนที่หน้า “บริษัท”</div>
      </div>
    );
  }

  const nowYear = Number(todayBkk().slice(0, 4));
  const year = /^\d{4}$/.test(searchParams.year ?? "") ? Number(searchParams.year) : nowYear;
  const data: CompanyFinancialYear = companyFinancialYear(companyId, year);
  const yearOptions = [nowYear, nowYear - 1, nowYear - 2];

  // Live monthly dashboard (owner 2026-07-29) — company totals + per-branch
  // comparison + this-month tax.
  const nowMonth = todayBkk().slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "") ? searchParams.month! : nowMonth;
  const ov = companyOverviewMonth(companyId, month);
  const maxBranchSales = Math.max(1, ...ov.branches.map((b) => b.sales));

  // รายได้คาดการณ์ทั้งเดือน (owner 2026-08-24) — run-rate: ยอดขายถึงวันนี้ ÷
  // วันที่ผ่านไป × วันทั้งเดือน. เฉพาะเดือนปัจจุบัน (เดือนที่ผ่านมามียอดครบแล้ว).
  const [fcY, fcM] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(fcY, fcM, 0)).getUTCDate();
  const elapsedDays = Number(todayBkk().slice(8, 10));
  const forecastSales = month === nowMonth && elapsedDays > 0
    ? Math.round((ov.totals.sales / elapsedDays) * daysInMonth * 100) / 100
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <div className="flex items-center gap-1">
          {yearOptions.map((y) => (
            <Link key={y} href={`/admin/accounta/company?year=${y}`}
              className={`rounded-lg px-2.5 py-1 text-sm font-medium ${y === year ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
              {y + 543}
            </Link>
          ))}
        </div>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-slate-800">ภาพรวมบริษัท (รวมสาขา)</h1>
        <p className="text-sm text-slate-500 mt-1">
          <b>{data.companyName}</b> · รวม {data.branchNames.length} สาขา
          {data.branchNames.length > 0 ? ` (${data.branchNames.join(" + ")})` : ""} · ปี {year + 543}
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          ตัวเลขรวมทุกสาขาของบริษัทนี้ · ใช้ติดตามภายใน ไม่ใช่เอกสารยื่นภาษีอย่างเป็นทางการ
        </p>
      </div>

      {/* ══ สรุปเดือน (live) — owner 2026-07-29 ══ */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold text-slate-800">สรุปเดือน {thMonthLabel(month)}</h2>
        <div className="flex items-center gap-1">
          <Link href={`/admin/accounta/company?month=${shiftMonth(month, -1)}`}
            className="rounded-lg px-2.5 py-1 text-sm bg-slate-100 text-slate-600 hover:bg-slate-200">← เดือนก่อน</Link>
          {month !== nowMonth && (
            <Link href="/admin/accounta/company"
              className="rounded-lg px-2.5 py-1 text-sm bg-slate-100 text-slate-600 hover:bg-slate-200">เดือนนี้</Link>
          )}
          {month < nowMonth && (
            <Link href={`/admin/accounta/company?month=${shiftMonth(month, 1)}`}
              className="rounded-lg px-2.5 py-1 text-sm bg-slate-100 text-slate-600 hover:bg-slate-200">เดือนถัดไป →</Link>
          )}
          {/* PDF infographic for C-level (owner 2026-09-02) */}
          <a href={`/api/admin/accounta/company/overview-pdf?month=${month}`} target="_blank" rel="noopener"
            className="rounded-lg px-2.5 py-1 text-sm bg-brand text-white hover:opacity-90">ดาวน์โหลด PDF</a>
        </div>
      </div>

      {/* Panel 1 — company totals */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card">
          <div className="text-xs text-slate-500">ยอดขายรวมทั้งบริษัท</div>
          <div className="text-2xl font-bold text-slate-800 mt-1 tabular-nums">{fmtMoney(ov.totals.sales)}</div>
          <div className="mt-1"><Delta now={ov.totals.sales} prev={ov.prev.sales} /></div>
          {month === nowMonth && (
            <div className="mt-2 pt-2 border-t border-slate-100 flex items-baseline justify-between">
              <span className="text-[11px] text-slate-500">วันนี้ ({thDayLabel(ov.today.date)})</span>
              <span className="text-sm font-semibold text-slate-700 tabular-nums">{fmtMoney(ov.today.sales)}</span>
            </div>
          )}
          {forecastSales != null && (
            <div className="mt-1 flex items-baseline justify-between"
              title={`คาดการณ์แบบ run-rate: ยอดขาย ${fmtMoney(ov.totals.sales)} ÷ ${elapsedDays} วัน × ${daysInMonth} วันทั้งเดือน`}>
              <span className="text-[11px] text-slate-400">คาดการณ์ทั้งเดือน</span>
              <span className="text-xs font-medium text-slate-500 tabular-nums">{fmtMoney(forecastSales)}</span>
            </div>
          )}
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">รายจ่าย</div>
          <div className="text-2xl font-bold text-slate-800 mt-1 tabular-nums">{fmtMoney(ov.totals.expense)}</div>
          <div className="mt-1"><Delta now={ov.totals.expense} prev={ov.prev.expense} goodUp={false} /></div>
        </div>
        <div className="card border-l-4 border-emerald-400">
          <div className="text-xs text-slate-500">กำไรสุทธิ (ก่อนภาษี)</div>
          <div className={`text-2xl font-bold mt-1 tabular-nums ${ov.totals.net >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{fmtMoney(ov.totals.net)}</div>
          <div className="mt-1"><Delta now={ov.totals.net} prev={ov.prev.net} /></div>
        </div>
      </div>

      {/* Panel 2 — per-branch comparison */}
      <div className="card overflow-x-auto">
        <h3 className="font-bold text-slate-800 mb-3">เทียบรายสาขา</h3>
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-100">
              <th className="text-left font-medium py-1.5 pr-2">สาขา</th>
              <th className="text-right font-medium py-1.5 px-2">ยอดขาย</th>
              <th className="text-right font-medium py-1.5 px-2">รายจ่าย</th>
              <th className="text-right font-medium py-1.5 px-2">กำไรสุทธิ</th>
              <th className="text-right font-medium py-1.5 pl-2">% ยอดขาย</th>
            </tr>
          </thead>
          <tbody>
            {ov.branches.map((b) => {
              const share = ov.totals.sales > 0 ? Math.round((b.sales / ov.totals.sales) * 100) : 0;
              return (
                <tr key={b.branchId} className="border-b border-slate-50 text-slate-700">
                  <td className="text-left py-2 pr-2 font-medium">
                    {b.name}
                    <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden" style={{ maxWidth: "160px" }}>
                      <div className="h-full bg-brand/70 rounded-full" style={{ width: `${Math.round((b.sales / maxBranchSales) * 100)}%` }}></div>
                    </div>
                  </td>
                  <td className="text-right py-2 px-2">{fmtMoney(b.sales)}</td>
                  <td className="text-right py-2 px-2 text-slate-500">{fmtMoney(b.expense)}</td>
                  <td className={`text-right py-2 px-2 font-semibold ${b.net >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{fmtMoney(b.net)}</td>
                  <td className="text-right py-2 pl-2 text-slate-500">{share}%</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-200 font-bold text-slate-800">
              <td className="text-left py-2 pr-2">รวมบริษัท</td>
              <td className="text-right py-2 px-2">{fmtMoney(ov.totals.sales)}</td>
              <td className="text-right py-2 px-2">{fmtMoney(ov.totals.expense)}</td>
              <td className={`text-right py-2 px-2 ${ov.totals.net >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{fmtMoney(ov.totals.net)}</td>
              <td className="text-right py-2 pl-2">100%</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Panel 3 — tax this month + company payables */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="card">
          <h3 className="font-bold text-slate-800 mb-2">ภาษีมูลค่าเพิ่ม (ภพ.30) เดือนนี้</h3>
          {ov.vatRegistered ? (
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">ภาษีขาย (จากยอด VAT)</span><span className="tabular-nums">{fmtMoney(ov.tax.outputVat)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">ภาษีซื้อ (บิลยืนยันแล้ว)</span><span className="tabular-nums">{fmtMoney(ov.tax.inputVat)}</span></div>
              <div className="flex justify-between border-t border-slate-100 pt-1.5 font-semibold">
                <span>ภพ.30 ที่ต้องยื่น</span>
                <span className={`tabular-nums ${ov.tax.vatPayable > 0 ? "text-rose-600" : "text-emerald-600"}`}>{fmtMoney(ov.tax.vatPayable)}</span>
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-amber-600">บริษัทนี้ยังไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม</p>
          )}
        </div>
        <div className="card">
          <h3 className="font-bold text-slate-800 mb-2">ค้างนำส่ง + ประมาณภาษีนิติบุคคล</h3>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">ภาษีหัก ณ ที่จ่าย (WHT) ค้าง</span><span className="tabular-nums">{fmtMoney(ov.payables.whtUnpaid)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">ประกันสังคมค้างนำส่ง</span><span className="tabular-nums">{fmtMoney(ov.payables.ssoUnpaid)}</span></div>
            <div className="flex justify-between border-t border-slate-100 pt-1.5">
              <span className="text-slate-500">กำไรสะสมปีนี้ ฐานภาษี ({ov.ytd.monthsElapsed} เดือน)</span>
              <span className={`tabular-nums ${ov.ytd.net >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{fmtMoney(ov.ytd.net)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>ประมาณภาษีนิติบุคคล (จากกำไรสะสม)</span>
              <span className="tabular-nums">{fmtMoney(ov.ytd.incomeTaxEst.tax)}</span>
            </div>
            <p className="text-[11px] text-slate-400 pt-0.5">
              กำไรสะสมฐานภาษี = ยอดขาย − รายจ่ายดำเนินงาน (ตัด CapEx/เงินกู้) จึงต่างจากกำไรสุทธิด้านบนที่รวมทุกบิล
            </p>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-1"></div>

      {/* ── VAT (ภพ.30) รายเดือน ยื่นรวม + ยอดขายรวม ── */}
      <div className="card">
        <h2 className="font-bold text-slate-800 mb-1">ภาษีมูลค่าเพิ่ม (ภพ.30) รายเดือน + ยอดขายรวม</h2>
        {!data.vatRegistered && (
          <p className="text-[11px] text-amber-600 mb-2">บริษัทนี้ยังไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม — แสดงเฉพาะยอดขายรวม</p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-100">
                <th className="text-left font-medium py-1.5 pr-2">เดือน</th>
                <th className="text-right font-medium py-1.5 px-2">ยอดขายรวม</th>
                {data.vatRegistered && <th className="text-right font-medium py-1.5 px-2">ภาษีขาย</th>}
                {data.vatRegistered && <th className="text-right font-medium py-1.5 px-2">ภาษีซื้อ</th>}
                {data.vatRegistered && <th className="text-right font-medium py-1.5 pl-2">ภพ.30 ที่ต้องยื่น</th>}
              </tr>
            </thead>
            <tbody>
              {data.months.map((m) => {
                const empty = m.sales === 0 && m.outputVat === 0 && m.inputVat === 0;
                return (
                  <tr key={m.month} className={`border-b border-slate-50 ${empty ? "text-slate-300" : "text-slate-700"}`}>
                    <td className="text-left py-1.5 pr-2">{TH_MON_ABBR[m.month]}</td>
                    <td className="text-right py-1.5 px-2">{fmtMoney(m.sales)}</td>
                    {data.vatRegistered && <td className="text-right py-1.5 px-2">{fmtMoney(m.outputVat)}</td>}
                    {data.vatRegistered && <td className="text-right py-1.5 px-2">{fmtMoney(m.inputVat)}</td>}
                    {data.vatRegistered && (
                      <td className={`text-right py-1.5 pl-2 font-semibold ${m.vatPayable > 0 ? "text-rose-600" : m.vatPayable < 0 ? "text-emerald-600" : ""}`}>
                        {fmtMoney(m.vatPayable)}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 font-bold text-slate-800">
                <td className="text-left py-2 pr-2">รวมทั้งปี</td>
                <td className="text-right py-2 px-2">{fmtMoney(data.annual.sales)}</td>
                {data.vatRegistered && <td className="text-right py-2 px-2">{fmtMoney(data.annual.outputVat)}</td>}
                {data.vatRegistered && <td className="text-right py-2 px-2">{fmtMoney(data.annual.inputVat)}</td>}
                {data.vatRegistered && <td className="text-right py-2 pl-2">{fmtMoney(data.annual.vatPayable)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
        {data.vatRegistered && (
          <p className="text-[11px] text-slate-400 mt-2">
            ภพ.30 ที่ต้องยื่น = ภาษีขาย − ภาษีซื้อ (ค่าติดลบ = ภาษีซื้อมากกว่า ขอคืน/ยกไปเดือนถัดไป) · ภาษีขาย = ฐานที่มี VAT × 7/107
          </p>
        )}
      </div>

      {/* ── สรุปสิ้นปี — ภาษีเงินได้นิติบุคคล (ประมาณการ) ── */}
      <div className="card">
        <h2 className="font-bold text-slate-800 mb-2">สรุปสิ้นปี — ประมาณการภาษีเงินได้นิติบุคคล</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
          <div className="rounded-xl bg-slate-50 p-3">
            <div className="text-[11px] text-slate-500">ยอดขายรวมทั้งปี</div>
            <div className="text-lg font-bold text-slate-800 tabular-nums">฿{fmtMoney(data.annual.sales)}</div>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <div className="text-[11px] text-slate-500">รายจ่ายดำเนินงาน</div>
            <div className="text-lg font-bold text-slate-800 tabular-nums">฿{fmtMoney(data.annual.opExpense)}</div>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <div className="text-[11px] text-slate-500">กำไรสุทธิ (ประมาณ)</div>
            <div className={`text-lg font-bold tabular-nums ${data.annual.netProfit >= 0 ? "text-slate-800" : "text-rose-600"}`}>฿{fmtMoney(data.annual.netProfit)}</div>
          </div>
          <div className="rounded-xl bg-brand/5 p-3">
            <div className="text-[11px] text-brand">ภาษีเงินได้ (ประมาณ)</div>
            <div className="text-lg font-bold text-brand tabular-nums">฿{fmtMoney(data.incomeTax.tax)}</div>
          </div>
        </div>

        {data.incomeTax.brackets.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-100">
                  <th className="text-left font-medium py-1.5 pr-2">ช่วงกำไรสุทธิ</th>
                  <th className="text-right font-medium py-1.5 px-2">อัตรา</th>
                  <th className="text-right font-medium py-1.5 px-2">ฐานในช่วง</th>
                  <th className="text-right font-medium py-1.5 pl-2">ภาษี</th>
                </tr>
              </thead>
              <tbody>
                {data.incomeTax.brackets.map((b, i) => (
                  <tr key={i} className="border-b border-slate-50 text-slate-700">
                    <td className="text-left py-1.5 pr-2">
                      {fmtMoney(b.from)}{b.to != null ? `–${fmtMoney(b.to)}` : " ขึ้นไป"}
                    </td>
                    <td className="text-right py-1.5 px-2">{Math.round(b.rate * 100)}%</td>
                    <td className="text-right py-1.5 px-2">{fmtMoney(b.taxable)}</td>
                    <td className="text-right py-1.5 pl-2 font-semibold">{fmtMoney(b.tax)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 font-bold text-slate-800">
                  <td className="text-left py-2 pr-2" colSpan={3}>
                    ภาษีประมาณการรวม (อัตราเฉลี่ย {(data.incomeTax.effectiveRate * 100).toLocaleString("th-TH", { maximumFractionDigits: 2 })}%)
                  </td>
                  <td className="text-right py-2 pl-2">฿{fmtMoney(data.incomeTax.tax)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-500">กำไรสุทธิไม่เกิน ฿300,000 (หรือขาดทุน) → ประมาณการภาษี ฿0</p>
        )}

        <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">
          หมายเหตุ: ประมาณการเบื้องต้นตามอัตรา SME (กำไร ≤300,000 = 0% · 300,001–3,000,000 = 15% · เกิน 3,000,000 = 20%)
          จากยอดขาย − รายจ่ายดำเนินงาน (ตัด CapEx และการชำระเงินกู้ออกแล้ว). <b>ยังไม่ใช่ยอดยื่นจริง</b> —
          ยังไม่รวมการปรับปรุงทางภาษี (ค่าเสื่อมราคา รายการบวกกลับ ผลขาดทุนยกมา ฯลฯ). ใช้เป็นแนวทางวางแผนเท่านั้น
          ยอดจริงให้ยืนยันกับสำนักงานบัญชี
        </p>
      </div>
    </div>
  );
}
