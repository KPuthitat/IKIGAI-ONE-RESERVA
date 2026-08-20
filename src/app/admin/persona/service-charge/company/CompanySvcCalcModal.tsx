"use client";

import { useState } from "react";
import { fmtMoney } from "@/lib/format";

// ปุ่ม "วิธีคำนวณ" + modal สำหรับหน้า SVC รวมทั้งบริษัท (owner 2026-08-18). ต่างจาก
// หน้าสาขาตรงที่แจกแจง "ได้จากสาขาไหนเท่าไหร่" ก่อน แล้วตามด้วยรายวัน (มีคอลัมน์สาขา).
type BranchShare = {
  branchId: number; branchName: string;
  grossAllocation: number; daysWorked: number; minutesWorked: number;
};
type BreakdownItem = {
  date: string; branchId: number; branchName: string;
  dayAmount: number; staffPool: number; userMinutes: number; totalMinutes: number; share: number;
};

const fmtMin = (min: number) => Math.round(min).toLocaleString();

export default function CompanySvcCalcModal({
  displayName, shared, byBranch, grossAllocation, netAllocation, forfeited,
  forfeitReason, dailyBreakdown, dayLedger, taxMode, whtAmount, groupInsurance, netPayout,
  foodClawback = 0, otherDeductions = 0, otherDeductionItems = []
}: {
  displayName: string;
  shared: boolean;
  byBranch: BranchShare[];
  grossAllocation: number;
  netAllocation: number;
  forfeited: boolean;
  forfeitReason: "late_20pct" | "resignation" | null;
  dailyBreakdown: BreakdownItem[];
  dayLedger?: Array<{ date: string; share: number; remark: string }>;
  taxMode: "sso" | "wht";
  whtAmount: number;
  groupInsurance: number;
  netPayout: number;
  foodClawback?: number;
  otherDeductions?: number;
  otherDeductionItems?: Array<{ id: number; amount: number; reason: string | null }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="inline-block text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium whitespace-nowrap">
        วิธีคำนวณ ↗
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-5xl w-full max-h-[85vh] overflow-y-auto p-4 sm:p-5"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-2 mb-1">
              <h3 className="font-bold text-slate-800">
                วิธีคำนวณเซอร์วิสชาร์จ — {displayName}
              </h3>
              <button type="button" onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
            </div>
            <div className="text-[11px] text-slate-500 mb-3">
              {shared
                ? "คำนวณรวมทั้งบริษัท: คนทำสาขามียอดได้ของสาขาตัวเอง · คนที่ถูกส่งไปสาขายังไม่มียอด ถูกดึงเข้าไปรับส่วนแบ่งจากสาขาที่มียอด"
                : "แต่ละสาขาแบ่งยอดของตัวเองให้พนักงานที่ทำงานสาขานั้น"}
            </div>

            {/* ได้จากสาขาไหนเท่าไหร่ */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 mb-3">
              <div className="text-[11px] font-bold text-slate-600 mb-1.5">
                ได้จากสาขาไหนเท่าไหร่
              </div>
              <table className="w-full text-[11px] tabular-nums">
                <thead>
                  <tr className="text-slate-500 text-left">
                    <th className="py-1 pr-2 font-medium">สาขา</th>
                    <th className="py-1 px-2 text-right font-medium">วันทำงาน</th>
                    <th className="py-1 px-2 text-right font-medium">ชั่วโมง</th>
                    <th className="py-1 pl-2 text-right font-medium">ส่วนแบ่ง</th>
                  </tr>
                </thead>
                <tbody>
                  {byBranch.map((b) => (
                    <tr key={b.branchId} className="text-slate-700">
                      <td className="py-1 pr-2 font-medium">{b.branchName}</td>
                      <td className="py-1 px-2 text-right">{b.daysWorked}</td>
                      <td className="py-1 px-2 text-right">{(b.minutesWorked / 60).toFixed(1)}</td>
                      <td className="py-1 pl-2 text-right font-semibold text-emerald-700">
                        {fmtMoney(b.grossAllocation)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200 font-bold text-slate-800">
                    <td className="py-1 pr-2" colSpan={3}>รวม</td>
                    <td className="py-1 pl-2 text-right">฿{fmtMoney(grossAllocation)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* รายวัน — ครบทุกวันของเดือน (วันไม่มีข้อมูลลง 0 + หมายเหตุ) */}
            {(!dayLedger?.length && dailyBreakdown.length === 0) ? (
              <p className="text-sm text-slate-500 py-4 text-center">ไม่มีวันที่ได้ส่วนแบ่งในเดือนนี้</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="text-slate-500 border-b border-slate-200 text-left">
                      <th className="py-1.5 pr-2 font-medium">วันที่</th>
                      <th className="py-1.5 px-2 font-medium">สาขา</th>
                      <th className="py-1.5 px-2 text-right font-medium">
                        {shared ? "ยอดกองสาขา" : "SVC วันนี้"}
                      </th>
                      <th className="py-1.5 px-2 text-right font-medium">ส่วนแบ่งพนักงาน</th>
                      <th className="py-1.5 px-2 text-right font-medium">นาทีที่ทำ</th>
                      <th className="py-1.5 px-2 text-right font-medium">นาทีรวมทั้งทีม</th>
                      <th className="py-1.5 pl-2 text-right font-medium">ส่วนแบ่ง</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dayLedger && dayLedger.length > 0
                      ? dayLedger.flatMap((ld) => {
                          const rows = dailyBreakdown.filter((b) => b.date === ld.date);
                          if (rows.length === 0) {
                            // Empty day — show 0 + the remark (ยังไม่เริ่มงาน/วันลา/วันหยุด/ไม่มียอด).
                            return [(
                              <tr key={ld.date} className="border-b border-slate-50 text-slate-400">
                                <td className="py-1.5 pr-2 whitespace-nowrap">{ld.date}</td>
                                <td className="py-1.5 px-2 italic" colSpan={5}>{ld.remark || "—"}</td>
                                <td className="py-1.5 pl-2 text-right">{fmtMoney(0)}</td>
                              </tr>
                            )];
                          }
                          return rows.map((d, i) => (
                            <tr key={`${d.date}-${d.branchId}-${i}`} className="border-b border-slate-50 text-slate-700">
                              <td className="py-1.5 pr-2 whitespace-nowrap">{i === 0 ? d.date : ""}</td>
                              <td className="py-1.5 px-2 text-slate-500 whitespace-nowrap">{d.branchName}</td>
                              <td className="py-1.5 px-2 text-right">{fmtMoney(d.dayAmount)}</td>
                              <td className="py-1.5 px-2 text-right">{fmtMoney(d.staffPool)}</td>
                              <td className="py-1.5 px-2 text-right">{fmtMin(d.userMinutes)}</td>
                              <td className="py-1.5 px-2 text-right text-slate-500">{fmtMin(d.totalMinutes)}</td>
                              <td className="py-1.5 pl-2 text-right font-semibold text-emerald-700">{fmtMoney(d.share)}</td>
                            </tr>
                          ));
                        })
                      : dailyBreakdown.map((d, i) => (
                          <tr key={`${d.date}-${d.branchId}-${i}`} className="border-b border-slate-50 text-slate-700">
                            <td className="py-1.5 pr-2">{d.date}</td>
                            <td className="py-1.5 px-2 text-slate-500">{d.branchName}</td>
                            <td className="py-1.5 px-2 text-right">{fmtMoney(d.dayAmount)}</td>
                            <td className="py-1.5 px-2 text-right">{fmtMoney(d.staffPool)}</td>
                            <td className="py-1.5 px-2 text-right">{fmtMin(d.userMinutes)}</td>
                            <td className="py-1.5 px-2 text-right text-slate-500">{fmtMin(d.totalMinutes)}</td>
                            <td className="py-1.5 pl-2 text-right font-semibold text-emerald-700">{fmtMoney(d.share)}</td>
                          </tr>
                        )))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 font-bold text-slate-800">
                      <td className="py-1.5 pr-2" colSpan={6}>รวมส่วนแบ่ง (ก่อนหักสาย/ลาออก)</td>
                      <td className="py-1.5 pl-2 text-right">฿{fmtMoney(grossAllocation)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {forfeited ? (
              <div className="mt-3 text-xs font-medium text-rose-600">
                ยอดสุทธิ = 0 (ถูกตัดสิทธิ์: {forfeitReason === "late_20pct" ? "สายเกิน 20% ทั้งบริษัท" : "ลาออก"})
              </div>
            ) : (
              <div className="mt-3 text-xs space-y-0.5">
                <div className="flex justify-between text-slate-600">
                  <span>รวมส่วนแบ่ง</span><span>฿{fmtMoney(grossAllocation)}</span>
                </div>
                {foodClawback > 0 && (
                  <div className="flex justify-between text-rose-600">
                    <span>หักค่าอาหาร (กลับก่อนครบกะ)</span><span>−฿{fmtMoney(foodClawback)}</span>
                  </div>
                )}
                {otherDeductions > 0 && (
                  <>
                    <div className="flex justify-between text-rose-600">
                      <span>หักรายการอื่นๆ</span><span>−฿{fmtMoney(otherDeductions)}</span>
                    </div>
                    {otherDeductionItems.map((it) => (
                      <div key={it.id} className="flex justify-between text-[10px] text-slate-400 pl-3">
                        <span>· {it.reason || "ไม่ระบุเหตุผล"}</span><span>−฿{fmtMoney(it.amount)}</span>
                      </div>
                    ))}
                    {otherDeductionItems.reduce((s, x) => s + x.amount, 0) > otherDeductions + 0.001 && (
                      <div className="text-[10px] text-amber-600 pl-3">* หักได้เท่าที่มี SVC (ส่วนเกินไม่หัก)</div>
                    )}
                  </>
                )}
                {groupInsurance > 0 && (
                  <div className="flex justify-between text-rose-600">
                    <span>หักประกันกลุ่ม</span><span>−฿{fmtMoney(groupInsurance)}</span>
                  </div>
                )}
                <div className="flex justify-between text-slate-600">
                  <span>ยอดก่อนหักภาษี</span><span>฿{fmtMoney(Math.max(0, netAllocation - groupInsurance))}</span>
                </div>
                {taxMode === "wht" && (
                  <div className="flex justify-between text-rose-600">
                    <span>หัก ณ ที่จ่าย 3%</span><span>−฿{fmtMoney(whtAmount)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-emerald-700 pt-0.5 border-t border-slate-100">
                  <span>ยอดจ่ายจริง{taxMode === "sso" ? " (ประกันสังคม — รับเต็ม)" : ""}</span>
                  <span>฿{fmtMoney(netPayout)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
