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

const fmtHr = (min: number) => `${(min / 60).toFixed(1)} ชม.`;

export default function SvcCalcModal({
  displayName, grossAllocation, netAllocation, forfeited, forfeitReason,
  dailyBreakdown, taxMode, whtAmount, netPayout
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
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="inline-block text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium whitespace-nowrap">วิธีคำนวณ ↗</button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-4 sm:p-5"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-2 mb-1">
              <h3 className="font-bold text-slate-800">วิธีคำนวณเซอร์วิสชาร์จ — {displayName}</h3>
              <button type="button" onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
            </div>
            <p className="text-[11px] text-slate-500 mb-3">
              ส่วนแบ่งเซอร์วิสชาร์จประจำวัน = เซอร์วิสชาร์จส่วนของพนักงาน (60%) ×
              (นาทีทำงานรวมของพนักงานคนนั้น ÷ นาทีทำงานรวมของพนักงานทุกคน)
              <span className="block mt-0.5 text-slate-400">
                นับเฉพาะเวลาทำงานตามกะ — มาก่อนเวลาเริ่มนับที่เวลากะ, หักเวลาพัก
              </span>
            </p>
            {dailyBreakdown.length === 0 ? (
              <p className="text-sm text-slate-500 py-4 text-center">ไม่มีวันที่ได้ส่วนแบ่งในเดือนนี้</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="text-slate-500 border-b border-slate-100 text-left">
                      <th className="py-1 pr-2 font-medium">วันที่</th>
                      <th className="py-1 px-2 text-right font-medium">ยอดวันนั้น</th>
                      <th className="py-1 px-2 text-right font-medium">×60%</th>
                      <th className="py-1 px-2 text-right font-medium">ชม.คุณ/รวม</th>
                      <th className="py-1 pl-2 text-right font-medium">ส่วนแบ่ง</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyBreakdown.map((d) => (
                      <tr key={d.date} className="border-b border-slate-50 text-slate-700">
                        <td className="py-1 pr-2">{d.date}</td>
                        <td className="py-1 px-2 text-right">{fmtMoney(d.dayAmount)}</td>
                        <td className="py-1 px-2 text-right">{fmtMoney(d.staffPool)}</td>
                        <td className="py-1 px-2 text-right">{fmtHr(d.userMinutes)}/{fmtHr(d.totalMinutes)}</td>
                        <td className="py-1 pl-2 text-right font-semibold text-emerald-700">{fmtMoney(d.share)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 font-bold text-slate-800">
                      <td className="py-1.5 pr-2" colSpan={4}>รวมส่วนแบ่ง (ก่อนหักสาย/ลาออก)</td>
                      <td className="py-1.5 pl-2 text-right">฿{fmtMoney(grossAllocation)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            {forfeited ? (
              <div className="mt-3 text-xs font-medium text-rose-600">
                ยอดสุทธิ = 0 (ถูกตัดสิทธิ์: {forfeitReason === "late_20pct" ? "สายเกิน 20%" : "ลาออก"})
              </div>
            ) : (
              <div className="mt-3 text-xs space-y-0.5">
                <div className="flex justify-between text-slate-600">
                  <span>รวมส่วนแบ่ง (ก่อนหักภาษี)</span><span>฿{fmtMoney(netAllocation)}</span>
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
