import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canManage, getManagerView } from "@/lib/special-duty-access";
import { daysInMonth, getMonth, listPositions } from "@/lib/special-duty";
import { dutyMonthSummary, dutyOwnerAlerts } from "@/lib/special-duty-payout";
import { viewerOf } from "@/lib/special-duty-viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ภาพรวมตำแหน่งงานค่าตอบแทนพิเศษ · NOKHOOK OS" };

const MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const DOW = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const STATUS_TH: Record<string, string> = {
  off: "ยังไม่เปิดใช้", awaiting_roster: "รอประกาศตารางงาน", booking_open: "เปิดให้เลือกวัน", booking_closed: "ปิดรับการเลือกวัน",
  filling: "กำลังจัดวันที่ว่าง", special_published: "ประกาศตารางแล้ว", in_progress: "อยู่ระหว่างปฏิบัติงาน", settled: "ปิดรอบแล้ว"
};
const DAY_TH: Record<string, string> = { absent: "ขาด", approved: "ตรวจรับ", submitted: "รอตรวจ", covered: "มีผู้แทน" };
const money = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shift = (ym: string, by: number) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7); };

// One screen for the owner: every branch's special-position schedule for a month side by side,
// with the month's cost and anything that needs attention. Managers see only their own branches.
export default function OverviewPage({ searchParams }: { searchParams: { month?: string } }) {
  const user = requireAdmin();
  const nowBkk = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "") ? (searchParams.month as string) : nowBkk;
  const v = viewerOf(user);
  const branches = (getDb().prepare("SELECT id, name FROM branches WHERE status != 'closed' ORDER BY display_order, name").all() as Array<{ id: number; name: string }>)
    .filter((b) => canManage(v, b.id))
    .map((b) => ({ ...b, m: getMonth(b.id, month) }))
    .filter((b) => b.m.enabled);
  const [y, m] = month.split("-").map(Number);
  const dim = daysInMonth(month);
  const total = branches.reduce((a, b) => { const s = dutyMonthSummary(b.id, month); return { approved: a.approved + s.approvedAmount, budget: a.budget + s.budget, days: a.days + s.approvedDays, pending: a.pending + s.pendingDays }; }, { approved: 0, budget: 0, days: 0, pending: 0 });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-slate-900">ภาพรวมตำแหน่งงานค่าตอบแทนพิเศษ</h1>
          <p className="text-sm text-slate-500 mt-1">ตารางและค่าใช้จ่ายของทุกสาขาในเดือนเดียวกัน</p>
        </div>
        <Link href={`/admin/persona/special-duty/settings?month=${month}`} className="btn-secondary !py-1 text-sm">ตั้งค่า</Link>
      </div>

      <div className="card flex items-center justify-between gap-2">
        <Link href={`?month=${shift(month, -1)}`} className="btn-secondary !py-1 !px-3 whitespace-nowrap">เดือนก่อน</Link>
        <div className="font-semibold text-slate-900">เดือน{MONTHS[m - 1]} {y + 543}</div>
        <Link href={`?month=${shift(month, 1)}`} className="btn-secondary !py-1 !px-3 whitespace-nowrap">เดือนถัดไป</Link>
      </div>

      {branches.length === 0 ? <div className="card text-sm text-slate-600">เดือนนี้ยังไม่มีสาขาที่เปิดใช้ตำแหน่งงานค่าตอบแทนพิเศษ</div> : (
        <>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="card"><div className="text-slate-500">ตรวจรับแล้วทุกสาขา ({total.days} วัน)</div><div className="text-lg font-bold text-emerald-700">{money(total.approved)} บาท</div></div>
            <div className="card"><div className="text-slate-500">ยังไม่ตรวจรับ</div><div className="text-lg font-bold text-amber-700">{total.pending} วัน</div><div className="text-xs text-slate-500">งบสูงสุดรวม {money(total.budget)} บาท</div></div>
          </div>

          {branches.map((b) => {
            const s = dutyMonthSummary(b.id, month);
            const alerts = ["special_published", "in_progress", "settled"].includes(b.m.status) ? dutyOwnerAlerts(b.id, month) : [];
            const positions = listPositions(b.id, month, { activeOnly: true });
            const rows = getManagerView(v, b.id, month);
            const at = new Map(rows.map((r) => [`${r.positionId}|${r.date}`, r]));
            return (
              <section key={b.id} className="card space-y-3">
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                  <h2 className="font-semibold text-slate-900">{b.name}</h2>
                  <span className="text-sm text-amber-800">{STATUS_TH[b.m.status] ?? b.m.status}</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                  <div className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">ตรวจรับแล้ว<div className="font-bold">{s.approvedDays} วัน · {money(s.approvedAmount)}</div></div>
                  <div className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">ยังไม่ตรวจรับ<div className="font-bold">{s.pendingDays} วัน</div></div>
                  <div className="rounded-lg bg-rose-50 px-3 py-2 text-rose-900">ขาด / ว่าง<div className="font-bold">{s.absentDays} / {s.unfilledDays} วัน</div></div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-800">งบสูงสุด<div className="font-bold">{money(s.budget)}</div></div>
                </div>
                {alerts.length > 0 && <ul className="text-sm text-rose-700 list-disc pl-5">{alerts.map((a, i) => <li key={i}>{a.text}</li>)}</ul>}
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-slate-200">
                        <th className="py-1 pr-2">วันที่</th>
                        {positions.map((p) => <th key={p.id} className="py-1 pr-2">{p.name}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: dim }, (_, i) => i + 1).map((d) => {
                        const date = `${month}-${String(d).padStart(2, "0")}`;
                        const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
                        return (
                          <tr key={d} className={`border-b border-slate-100 ${dow === 0 || dow === 6 ? "bg-slate-50" : ""}`}>
                            <td className="py-1 pr-2 whitespace-nowrap text-slate-600">{DOW[dow]} {d}</td>
                            {positions.map((p) => {
                              const r = at.get(`${p.id}|${date}`);
                              return (
                                <td key={p.id} className="py-1 pr-2 whitespace-nowrap">
                                  {r ? <span className={r.status === "absent" ? "text-rose-700 font-medium" : r.status === "approved" ? "text-emerald-700" : "text-slate-800"}>
                                    {r.performerName ?? r.name}{DAY_TH[r.status] ? ` (${DAY_TH[r.status]})` : ""}
                                  </span> : <span className="text-rose-400">ว่าง</span>}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
