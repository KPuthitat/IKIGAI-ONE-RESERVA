// /admin/ascenda/kpis — KPI management (Phase 2).
//
// Adds/edits/deletes/reorders/toggles. The interactive parts live in
// KpisClient (client component); this server page just fetches the
// list. Showing all rows (active + inactive) so admin can re-activate
// a previously disabled KPI from the same screen.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { listKpis } from "@/lib/ascenda";
import KpisClient from "./KpisClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "เกณฑ์ KPI · ASCENDA" };

export default function AscendaKpisPage() {
  requireAdmin();
  const kpis = listKpis(undefined, false);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/ascenda" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ ASCENDA
        </Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">เกณฑ์ KPI</h1>
        <p className="text-sm text-slate-500">
          จัดการเกณฑ์ที่ใช้ประเมินรายเดือน — เพิ่ม / แก้ไข / ลบ / เปิดปิด / จัดลำดับ
        </p>
      </div>

      <KpisClient kpis={kpis} />
    </div>
  );
}
