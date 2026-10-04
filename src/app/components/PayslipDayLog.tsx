import type { Lang } from "@/lib/i18n";
import { fmtMoney } from "@/lib/format";
import type { BreakdownDay } from "@/lib/payroll-breakdown";

// Per-day time log shared by every payslip (owner 2026-10-01: "พนักงานต้องเห็น
// วิธีการคำนวณรายวันเพื่อความโปร่งใส"). The per-round slip and the monthly slip
// both render this ONE table from buildLineBreakdown, so the evidence behind a
// figure reads the same wherever it is opened. Presentational only.

export function fmtMin(min: number, lang: Lang): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0 && m === 0) return "—";
  if (lang === "th") {
    if (h === 0) return `${m} นาที`;
    if (m === 0) return `${h} ชั่วโมง`;
    return `${h} ชั่วโมง ${m} นาที`;
  }
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

export default function PayslipDayLog({
  lang, dayLog, isAdmin, title, showDayPay = false, compact = false
}: {
  lang: Lang;
  dayLog: BreakdownDay[];
  isAdmin: boolean;
  title?: string;
  // PT / hourly lines: show the baht earned that day (hours × rate incl. OT).
  // Off for a salaried FT round, whose per-day figure is only the OT/premium delta.
  showDayPay?: boolean;
  // Monthly slip stacks several rounds — tighter heading, legend printed once by the caller.
  compact?: boolean;
}) {
  if (dayLog.length === 0) return null;
  const sumPay = dayLog.reduce((s, d) => s + d.pay, 0);
  return (
    <div className={compact ? "my-2" : "my-4"}>
      <div className={`${compact ? "text-xs" : "text-sm"} font-semibold text-slate-700 border-b border-slate-200 pb-1 mb-2`}>
        {title ?? "รายละเอียดการปฏิบัติงานรายวัน"}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200">
              <th className="py-1 pr-2 font-medium">วันที่</th>
              <th className="py-1 pr-2 font-medium">เวลาเข้า–ออก</th>
              <th className="py-1 pr-2 font-medium text-right">ชั่วโมงทำงาน</th>
              <th className="py-1 pr-2 font-medium text-right">ค่าล่วงเวลา</th>
              {showDayPay && <th className="py-1 pr-2 font-medium text-right">ค่าตอบแทน</th>}
              <th className="py-1 font-medium">หมายเหตุ</th>
            </tr>
          </thead>
          <tbody>
            {dayLog.map((d) => {
              const worked = d.pairs.filter((p) => p.workIn || p.workOut);
              const first = worked[0];
              const last = worked[worked.length - 1];
              const clock = first
                ? `${first.workIn ?? "—"}–${last?.workOut ?? "—"}`
                : (d.pairs[0]?.statusLabel ?? "—");
              const isDouble = d.pairs.some((p) => p.double);
              const isSpecial = d.pairs.some((p) => p.holiday);
              const status = d.pairs.find((p) => p.statusLabel)?.statusLabel ?? null;
              // ค่าล่วงเวลาต่อวัน = OT + เบี้ยวันจ่ายสองเท่า (owner 2026-09-05).
              // เบี้ยวันพิเศษ ×1.5 อยู่ในฐาน จึงไม่รวมที่นี่.
              const otAmt = Math.round((d.otPay + (isDouble ? d.premiumPay : 0)) * 100) / 100;
              return (
                <tr key={d.date} className="border-b border-slate-100 last:border-0">
                  <td className="py-1 pr-2 whitespace-nowrap tabular-nums text-slate-600">
                    {d.date.slice(5)}
                  </td>
                  <td className="py-1 pr-2 whitespace-nowrap tabular-nums text-slate-700">
                    {worked.length > 0 ? clock : (() => {
                      // ไม่ต้องลงเวลา: no punches, so show the rostered window instead of a bare status.
                      const sp = d.pairs.find((p) => p.statusLabel === "ตามตารางกะ" && p.schedIn && p.schedOut);
                      return sp ? `${sp.schedIn}–${sp.schedOut}` : <span className="text-slate-400">{status ?? "—"}</span>;
                    })()}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-slate-700">
                    {d.effectiveMinutes > 0 ? fmtMin(d.effectiveMinutes, lang) : "—"}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-slate-700 whitespace-nowrap">
                    {d.otMinutes === 0 && otAmt === 0 ? "—" : (
                      <>
                        {d.otMinutes > 0 && fmtMin(d.otMinutes, lang)}
                        {otAmt > 0 && <span className="block text-[10px] text-emerald-700">฿{fmtMoney(otAmt)}</span>}
                      </>
                    )}
                  </td>
                  {showDayPay && (
                    <td className="py-1 pr-2 text-right tabular-nums text-slate-800 whitespace-nowrap">
                      {d.pay > 0 ? fmtMoney(d.pay) : "—"}
                    </td>
                  )}
                  <td className="py-1">
                    <span className="flex flex-wrap items-center gap-1">
                      {isDouble && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-rose-100 text-rose-700 font-bold">
                          จ่ายสองเท่า{d.premiumPay > 0 ? ` (เบี้ย ฿${fmtMoney(d.premiumPay)} รวมในค่าล่วงเวลา)` : ""}
                        </span>
                      )}
                      {isSpecial && !isDouble && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-violet-100 text-violet-700">
                          ค่าตอบแทนวันพิเศษ{d.premiumPay > 0 ? ` +฿${fmtMoney(d.premiumPay)}` : ""}
                        </span>
                      )}
                      {d.absenceDeduction > 0 && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-rose-100 text-rose-700 font-medium">
                          หักค่าจ้างวันขาดงาน −฿{fmtMoney(d.absenceDeduction)}
                        </span>
                      )}
                      {worked.length === 0 && status === "ตามตารางกะ" && <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-50 text-emerald-700">ตามตารางกะ</span>}
                      {worked.length > 0 && status && <span className="text-[9px] px-1 py-0.5 rounded bg-slate-100 text-slate-500">{status}</span>}
                      {worked.length > 0 && d.pairs[0]?.branch && <span className="text-[9px] text-slate-400">{d.pairs[0].branch}</span>}
                      {isAdmin && d.edited && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700">แก้ไข</span>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {showDayPay && sumPay > 0 && (
            <tfoot>
              <tr className="border-t border-slate-300 font-semibold text-slate-800">
                <td className="py-1 pr-2" colSpan={4}>รวมค่าตอบแทนในงวด</td>
                <td className="py-1 pr-2 text-right tabular-nums">{fmtMoney(sumPay)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {!compact && <PayslipDayLogLegend showDayPay={showDayPay} />}
    </div>
  );
}

/** The reading guide under the table — printed once per slip. */
export function PayslipDayLogLegend({ showDayPay = false }: { showDayPay?: boolean }) {
  return (
    <p className="text-[10px] text-slate-400 mt-1.5 leading-relaxed">
      คำอธิบาย: “ชั่วโมงทำงาน” คือเวลาทำงานหลังหักเวลาพักและปรับตามกะแล้ว ·
      คอลัมน์ “ค่าล่วงเวลา” แสดงชั่วโมงและจำนวนเงินในวันนั้น โดย<b>รวมค่าตอบแทนวันจ่ายสองเท่าไว้แล้ว</b> ·
      {showDayPay && <> “ค่าตอบแทน” = ชั่วโมงทำงาน × อัตราต่อชั่วโมง (รวมค่าล่วงเวลาของวันนั้น) ·</>}
      {" "}ป้าย “จ่ายสองเท่า” = วันที่ได้ค่าตอบแทนสองเท่า (เบี้ยส่วนเพิ่มรวมอยู่ในค่าล่วงเวลา) · “ค่าตอบแทนวันพิเศษ +฿” = ส่วนเพิ่มในวันพิเศษ (รวมอยู่ในค่าตอบแทนฐาน) ·
      “หักค่าจ้างวันขาดงาน −฿” คือจำนวนเงินที่ถูกหักเมื่อขาดงานโดยไม่ลา (คำนวณจากเงินเดือนหารด้วย 30 วัน)
    </p>
  );
}
