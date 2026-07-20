"use client";

import { useState } from "react";
import { fmtMoney } from "@/lib/format";

// ปุ่ม "วิธีคำนวณ" + modal แจกแจงว่าส่วนแบ่งเซอร์วิสชาร์จของคนนั้นมาจากไหน
// (owner 2026-07-20). แต่ละวัน: ยอด SVC วันนั้น × 60% × (นาทีของคุณ ÷ นาทีรวมทั้งวัน).
type BreakdownItem = {
  date: string; dayAmount: number; staffPool: number;
  userMinutes: number; totalMinutes: number; share: number;
};

const fmtHr = (min: number) => `${(min / 60).toFixed(1)} ชม.`;

export default function SvcCalcModal({
  displayName, grossAllocation, netAllocation, forfeited, forfeitReason, dailyBreakdown
}: {
  displayName: string;
  grossAllocation: number;
  netAllocation: number;
  forfeited: boolean;
  forfeitReason: "late_20pct" | "resignation" | null;
  dailyBreakdown: BreakdownItem[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="text-[11px] font-medium text-brand hover:underline whitespace-nowrap">วิธีคำนวณ</button>
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
              แต่ละวัน: ยอด SVC วันนั้น × 60% (ส่วนพนักงาน) × (นาทีของคุณ ÷ นาทีรวมทั้งวัน)
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
            <div className={`mt-3 text-xs font-medium ${forfeited ? "text-rose-600" : "text-emerald-700"}`}>
              {forfeited
                ? `ยอดสุทธิ = 0 (ถูกตัดสิทธิ์: ${forfeitReason === "late_20pct" ? "สายเกิน 20%" : "ลาออก"})`
                : `ยอดสุทธิที่ได้รับ = ฿${fmtMoney(netAllocation)}`}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
