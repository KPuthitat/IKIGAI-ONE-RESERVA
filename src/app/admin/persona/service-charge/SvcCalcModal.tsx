"use client";

import { useState } from "react";
import { fmtMoney } from "@/lib/format";

// ปุ่ม "วิธีคำนวณ" + modal แจกแจงว่าส่วนแบ่งเซอร์วิสชาร์จของคนนั้นมาจากไหน
// (owner 2026-07-20). ส่วนแบ่งประจำวัน = เซอร์วิสชาร์จส่วนของพนักงาน × (นาที
// ทำงานของคนนั้น ÷ นาทีทำงานรวมของทุกคน). นาทีนับตามกะ (มาก่อนเวลาเริ่มนับที่เวลากะ).
type BreakdownItem = {
  date: string; dayAmount: number; staffPool: number;
  userMinutes: number; totalMinutes: number; share: number;
};

const fmtMin = (min: number) => Math.round(min).toLocaleString();

export default function SvcCalcModal({
  displayName, grossAllocation, netAllocation, forfeited, forfeitReason,
  dailyBreakdown, taxMode, whtAmount, netPayout, excludedDays,
  foodClawback = 0, foodClawbackDays = [],
  otherDeductions = 0, otherDeductionItems = []
}: {
  displayName: string;
  grossAllocation: number;
  netAllocation: number;
  forfeited: boolean;
  forfeitReason: "late_20pct" | "resignation" | null;
  dailyBreakdown: BreakdownItem[];
  taxMode: "sso" | "wht";
  whtAmount: number;
  netPayout: number;
  excludedDays: Array<{ date: string; reason: string }>;
  foodClawback?: number;
  foodClawbackDays?: Array<{ date: string; credit: number }>;
  otherDeductions?: number;
  otherDeductionItems?: Array<{ id: number; amount: number; reason: string | null }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="inline-block text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium whitespace-nowrap">วิธีคำนวณ ↗</button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-4 sm:p-5"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-2 mb-1">
              <h3 className="font-bold text-slate-800">วิธีคำนวณเซอร์วิสชาร์จ — {displayName}</h3>
              <button type="button" onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
            </div>
            {/* สูตรแบบกล่อง อ่านง่าย (owner 2026-07-21) */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 mb-3">
              <div className="flex items-center justify-center gap-2 text-slate-800 font-semibold flex-wrap text-center">
                <span>ส่วนแบ่ง</span>
                <span className="text-slate-400">=</span>
                <span className="text-brand">ส่วนแบ่งพนักงาน (60%)</span>
                <span className="text-slate-400">×</span>
                <span className="inline-flex flex-col items-center leading-tight text-[12px]">
                  <span className="px-2 pb-0.5">จำนวนนาทีที่ทำงาน</span>
                  <span className="w-full border-t border-slate-400"></span>
                  <span className="px-2 pt-0.5">นาทีทำงานรวมทั้งทีม</span>
                </span>
              </div>
              <div className="text-center text-[11px] text-slate-400 mt-2">
                นับเฉพาะเวลาทำงานตามกะ · หักเวลาพัก · มาก่อนเวลาเริ่มนับที่เวลากะ
              </div>
            </div>
            {dailyBreakdown.length === 0 ? (
              <p className="text-sm text-slate-500 py-4 text-center">ไม่มีวันที่ได้ส่วนแบ่งในเดือนนี้</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="text-slate-500 border-b border-slate-200 text-left">
                      <th className="py-1.5 pr-2 font-medium">วันที่</th>
                      <th className="py-1.5 px-2 text-right font-medium">เซอร์วิสชาร์จวันนี้</th>
                      <th className="py-1.5 px-2 text-right font-medium">ส่วนแบ่งพนักงาน</th>
                      <th className="py-1.5 px-2 text-right font-medium">จำนวนนาทีที่ทำงาน</th>
                      <th className="py-1.5 px-2 text-right font-medium">นาทีทำงานรวมทั้งทีม</th>
                      <th className="py-1.5 pl-2 text-right font-medium">ส่วนแบ่ง</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyBreakdown.map((d) => (
                      <tr key={d.date} className="border-b border-slate-50 text-slate-700">
                        <td className="py-1.5 pr-2">{d.date}</td>
                        <td className="py-1.5 px-2 text-right">{fmtMoney(d.dayAmount)}</td>
                        <td className="py-1.5 px-2 text-right">{fmtMoney(d.staffPool)}</td>
                        <td className="py-1.5 px-2 text-right">{fmtMin(d.userMinutes)}</td>
                        <td className="py-1.5 px-2 text-right text-slate-500">{fmtMin(d.totalMinutes)}</td>
                        <td className="py-1.5 pl-2 text-right font-semibold text-emerald-700">{fmtMoney(d.share)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 font-bold text-slate-800">
                      <td className="py-1.5 pr-2" colSpan={5}>รวมส่วนแบ่ง (ก่อนหักสาย/ลาออก)</td>
                      <td className="py-1.5 pl-2 text-right">฿{fmtMoney(grossAllocation)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            {excludedDays.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <div className="text-[11px] font-bold text-amber-800 mb-1">
                  วันที่ถูกตัดสิทธิ์ (เวลางานผิดปกติ — ไม่นับ SVC)
                </div>
                <ul className="text-[11px] text-amber-700 space-y-0.5">
                  {excludedDays.map((d) => (
                    <li key={d.date} className="flex justify-between gap-2">
                      <span>{d.date}</span><span>{d.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {foodClawback > 0 && foodClawbackDays.length > 0 && (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
                <div className="text-[11px] font-bold text-rose-800 mb-1">
                  หักค่าอาหารกลางวัน (เบิกแล้วกลับก่อนครบกะ · ไม่ได้ขออนุมัติ)
                </div>
                <ul className="text-[11px] text-rose-700 space-y-0.5">
                  {foodClawbackDays.map((d) => (
                    <li key={d.date} className="flex justify-between gap-2">
                      <span>{d.date}</span><span>−฿{fmtMoney(d.credit)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {forfeited ? (
              <div className="mt-3 text-xs font-medium text-rose-600">
                ยอดสุทธิ = 0 (ถูกตัดสิทธิ์: {forfeitReason === "late_20pct" ? "สายเกิน 20%" : "ลาออก"})
              </div>
            ) : (
              <div className="mt-3 text-xs space-y-0.5">
                <div className="flex justify-between text-slate-600">
                  <span>รวมส่วนแบ่ง</span><span>฿{fmtMoney(grossAllocation)}</span>
                </div>
                {foodClawback > 0 && (
                  <div className="flex justify-between text-rose-600">
                    <span>หักค่าอาหารกลางวัน (กลับก่อนครบกะ)</span><span>−฿{fmtMoney(foodClawback)}</span>
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
                      <div className="text-[10px] text-amber-600 pl-3">* หักได้เท่าที่มี SVC (ส่วนเกินยกไป/ไม่หัก)</div>
                    )}
                  </>
                )}
                <div className="flex justify-between text-slate-600">
                  <span>ยอดก่อนหักภาษี</span><span>฿{fmtMoney(netAllocation)}</span>
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
