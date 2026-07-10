import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fmtMoney } from "@/lib/format";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { deliveraSalesReport } from "@/lib/delivera/report";
import CodClient from "./CodClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ยอดขายเดลิเวอรี่ · DELIVERA" };

const TH_MON = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
function monthLabel(ym: string): string { const [y, m] = ym.split("-").map(Number); return `${TH_MON[m]} ${y + 543}`; }
function dayLabel(d: string): string { const [, , dd] = d.split("-"); return String(Number(dd)); }

export default function DeliveraReportPage({ searchParams }: { searchParams: { month?: string } }) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return <div className="card text-sm text-slate-600">ยังไม่ได้เลือกสาขา</div>;
  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(user.activeBranchId) as { name: string } | undefined;
  if (!isDeliveraBranch(user.activeBranchId)) {
    return <div className="card text-sm text-slate-600">สาขานี้ยังไม่ได้เปิด DELIVERA</div>;
  }

  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "") ? searchParams.month! : undefined;
  const r = deliveraSalesReport(user.activeBranchId, month);
  const [y, m] = r.month.split("-").map(Number);
  const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}`;
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">ยอดขายเดลิเวอรี่ (ส่งเอง)</h1>
          <p className="text-sm text-slate-500">สาขา <b>{branch?.name}</b> · เก็บแยกจากบัญชี — นับเฉพาะบิลที่ส่งถึง/รับแล้ว</p>
        </div>
        <Link href="/admin/delivera/kitchen" className="text-sm text-slate-500 hover:text-brand">← กระดานครัว</Link>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="วันนี้" bills={r.today.bills} total={r.today.total} accent />
        <Stat label={`เดือนนี้ (${monthLabel(r.month)})`} bills={r.monthTotal.bills} total={r.monthTotal.total} />
        <Stat label="เก็บปลายทาง (COD)" bills={r.byMethod.cod.bills} total={r.byMethod.cod.total} />
        <Stat label="โอน/PromptPay" bills={r.byMethod.promptpay.bills} total={r.byMethod.promptpay.total} />
      </div>

      <div className="card">
        <h2 className="font-bold text-slate-800 mb-2">เงินปลายทาง (COD) ค้างรับจากไรเดอร์</h2>
        <CodClient />
      </div>

      <div className="card">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-slate-800">รายวัน · {monthLabel(r.month)}</h2>
          <div className="flex items-center gap-2 text-sm">
            <Link href={`?month=${prev}`} className="text-slate-500 hover:text-brand">← ก่อนหน้า</Link>
            <Link href={`?month=${next}`} className="text-slate-500 hover:text-brand">ถัดไป →</Link>
          </div>
        </div>
        {r.days.length === 0 ? (
          <p className="text-sm text-slate-400 mt-2">ยังไม่มียอดขายเดลิเวอรี่ในเดือนนี้</p>
        ) : (
          <table className="w-full text-sm mt-2">
            <thead>
              <tr className="text-slate-400 text-xs border-b border-slate-100">
                <th className="text-left py-1.5">วันที่</th>
                <th className="text-right py-1.5">จำนวนบิล</th>
                <th className="text-right py-1.5">ยอดรวม</th>
              </tr>
            </thead>
            <tbody>
              {r.days.map((d) => (
                <tr key={d.date} className="border-b border-slate-50">
                  <td className="py-1.5 text-slate-700">{dayLabel(d.date)} {monthLabel(r.month)}</td>
                  <td className="py-1.5 text-right text-slate-600">{d.bills}</td>
                  <td className="py-1.5 text-right font-mono text-slate-800">฿{fmtMoney(d.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-[11px] text-slate-400 mt-2">
          ตัวเลขนี้เป็นข้อมูลของเดลิเวอรี่โดยเฉพาะ ไม่ได้ลงบัญชี ACCOUNTA ซ้ำ (ยอดขายรวมนับในรายงานปิดกะอยู่แล้ว)
        </p>
      </div>
    </div>
  );
}

function Stat({ label, bills, total, accent }: { label: string; bills: number; total: number; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${accent ? "border-brand/30 bg-brand/5" : "border-slate-200 bg-slate-50"}`}>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-lg font-bold text-slate-800">฿{fmtMoney(total)}</div>
      <div className="text-[11px] text-slate-400">{bills} บิล</div>
    </div>
  );
}
