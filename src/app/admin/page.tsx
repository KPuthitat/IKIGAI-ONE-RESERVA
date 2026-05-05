import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Admin" };

// /admin — หน้าหลักแอดมิน เลือก module ที่จะเข้า
export default function AdminHomePage() {
  requireAdmin();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">เลือก module</h1>
        <p className="text-sm text-slate-500 mt-1">หลังบ้านสำหรับผู้ดูแลระบบ</p>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Link href="/admin/persona" className="card hover:shadow-2xl transition group block">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">MODULE</div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            PERSONA
          </h2>
          <p className="text-slate-500 text-sm mt-1">
            ระบบบริหารงานบุคคล · พนักงาน เงินเดือน เวลาเข้าออก
          </p>
          <p className="mt-4 text-brand font-bold text-sm">เข้าหลังบ้าน →</p>
        </Link>

        <Link href="/admin/reserva" className="card hover:shadow-2xl transition group block">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">MODULE</div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            RESERVA
          </h2>
          <p className="text-slate-500 text-sm mt-1">
            ระบบจองโต๊ะ · floor plan, การจอง, สถิติ
          </p>
          <p className="mt-4 text-brand font-bold text-sm">เข้าหลังบ้าน →</p>
        </Link>
      </div>
    </div>
  );
}
