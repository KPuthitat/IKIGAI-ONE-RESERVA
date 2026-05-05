import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Staff" };

export default function StaffHomePage({
  searchParams
}: { searchParams: { error?: string } }) {
  const user = requireUser();
  const showForbidden = searchParams.error === "forbidden";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">เลือก module</h1>
        <p className="text-sm text-slate-500 mt-1">
          {user.display_name} · พนักงาน
        </p>
        {showForbidden && (
          <div className="mt-3 text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3">
            ไม่มีสิทธิ์เข้าฝั่งผู้ดูแล — ใช้ฝั่งพนักงานแทน
          </div>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Link href="/staff/persona" className="card hover:shadow-2xl transition group block">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">MODULE</div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            PERSONA
          </h2>
          <p className="text-slate-500 text-sm mt-1">ลงเวลาเข้า/ออกงาน · ดูประวัติของตัวเอง</p>
          <p className="mt-4 text-brand font-bold text-sm">เปิด →</p>
        </Link>

        <Link href="/staff/reserva" className="card hover:shadow-2xl transition group block">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">MODULE</div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            RESERVA
          </h2>
          <p className="text-slate-500 text-sm mt-1">ดูการจองของลูกค้า · กดสถานะมาแล้ว/ไม่มา</p>
          <p className="mt-4 text-brand font-bold text-sm">เปิด →</p>
        </Link>
      </div>

      <div className="text-center text-xs text-slate-400 mt-8">
        ทางลัด: <a href="/persona" className="hover:text-brand">ikigaimedihealth.com/persona</a> ลงเวลาตรง
      </div>
    </div>
  );
}
