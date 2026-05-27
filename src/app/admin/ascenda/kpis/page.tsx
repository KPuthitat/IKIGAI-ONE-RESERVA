// /admin/ascenda/kpis — KPI management (Phase 2 placeholder).
//
// Phase 1 ships a read-only list so admin can see the seeded 7 KPIs
// + their kind / target / weight, but editing flows are Phase 2.
// Add/remove/reorder/edit-target UI all comes here in the next commit.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { listKpis, kindLabelTh } from "@/lib/ascenda";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "เกณฑ์ KPI · ASCENDA" };

export default function AscendaKpisPage() {
  requireAdmin();
  // Show ALL KPIs (active + inactive) so admin can re-activate one
  // they previously turned off. The active toggle is Phase 2.
  const kpis = listKpis(undefined, false);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/ascenda" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ ASCENDA
        </Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">เกณฑ์ KPI</h1>
        <p className="text-sm text-slate-500">
          รายการเกณฑ์ที่ใช้ประเมินรายเดือน — เพิ่ม / ลบ / ปรับน้ำหนักได้ในเฟส 2
        </p>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-left">
              <th className="py-2 pr-3 font-semibold text-slate-600 w-10">#</th>
              <th className="py-2 pr-3 font-semibold text-slate-600">เกณฑ์</th>
              <th className="py-2 pr-3 font-semibold text-slate-600 w-24">ระดับ</th>
              <th className="py-2 pr-3 font-semibold text-slate-600 w-40">ที่มา</th>
              <th className="py-2 pr-3 font-semibold text-slate-600 text-center w-32">เป้า</th>
              <th className="py-2 pr-3 font-semibold text-slate-600 text-center w-16">น้ำหนัก</th>
              <th className="py-2 pr-3 font-semibold text-slate-600 text-center w-20">สถานะ</th>
            </tr>
          </thead>
          <tbody>
            {kpis.map((k) => (
              <tr key={k.id} className="border-b border-slate-100 last:border-b-0">
                <td className="py-2 pr-3 text-slate-400">{k.display_order}</td>
                <td className="py-2 pr-3">
                  <div className="font-medium text-slate-800">{k.title}</div>
                  {k.description && (
                    <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">
                      {k.description}
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                    k.scope === "branch"
                      ? "bg-blue-100 text-blue-700"
                      : "bg-purple-100 text-purple-700"
                  }`}>
                    {k.scope === "branch" ? "สาขา" : "บริษัท"}
                  </span>
                </td>
                <td className="py-2 pr-3 text-slate-600 text-[11px]">
                  {kindLabelTh(k.kind)}
                </td>
                <td className="py-2 pr-3 text-center font-mono tabular-nums text-slate-700">
                  {k.target_value != null && k.target_op
                    ? `${k.target_op === "lte" ? "≤" : k.target_op === "gte" ? "≥" : "="} ${k.target_value}${k.unit ?? ""}`
                    : "—"}
                </td>
                <td className="py-2 pr-3 text-center text-slate-600 font-mono">
                  ×{k.weight}
                </td>
                <td className="py-2 pr-3 text-center">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                    k.active === 1
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-slate-200 text-slate-500"
                  }`}>
                    {k.active === 1 ? "ใช้งาน" : "ปิด"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card bg-slate-50 border-slate-200 text-[11px] text-slate-500 space-y-1">
        <div className="font-bold text-slate-600">รออยู่ใน Phase 2</div>
        <div>· ปุ่ม + เพิ่มเกณฑ์ใหม่ — กรอก ชื่อ / ที่มา / เป้า / น้ำหนัก</div>
        <div>· ปุ่มแก้ไข + ลบ + เปิด/ปิดใช้งาน per row</div>
        <div>· ลากจัดลำดับใหม่ (display_order)</div>
      </div>
    </div>
  );
}
