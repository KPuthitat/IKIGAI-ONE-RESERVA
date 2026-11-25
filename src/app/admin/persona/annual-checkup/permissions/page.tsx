import type { Metadata } from "next";
import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth";
import { listClinicPeople, listGrants } from "@/lib/annual-checkup-db";
import PermissionsClient from "./PermissionsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สิทธิ์ระบบผลตรวจสุขภาพ · PERSONA" };

export default function PermissionsPage() {
  const user = requireSuperAdmin();
  const people = listClinicPeople(user);
  const grants = listGrants(user).slice(0, 60) as Array<{ id: number; user_name: string; capability: string; action: string; reason: string | null; created_at: string }>;
  return (
    <div className="space-y-4">
      <Link href="/admin/persona/annual-checkup" className="text-sm text-slate-500 hover:text-brand">← ตรวจสุขภาพประจำปี</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">สิทธิ์ระบบผลตรวจสุขภาพ</h1>
        <p className="text-sm text-slate-500">เจ้าหน้าที่กรอกผล = กรอก/นำเข้า/แนบไฟล์/ส่งให้แพทย์ แต่อนุมัติและเปิดผลไม่ได้ · แพทย์ผู้อนุมัติ = ทำได้ทุกอย่าง รวมเขียนสรุป ส่งกลับ อนุมัติ เปิดผล (ต้องเป็นแพทย์ที่มีเลขใบอนุญาต) · สิทธิ์ใช้ได้เฉพาะคนที่อยู่สาขา AT HOME CLINIC ทุกครั้งที่ใช้งาน ถ้าย้ายออกสิทธิ์หยุดทันที · ทุกการให้และถอนสิทธิ์เก็บประวัติพร้อมเหตุผล</p>
      </div>
      <PermissionsClient people={people} />
      <div className="card overflow-x-auto">
        <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-800">ประวัติการให้และถอนสิทธิ์ (ล่าสุด 60 รายการ)</div>
        <table className="w-full text-sm min-w-[560px]">
          <thead className="text-left text-slate-500"><tr><th className="px-4 py-2">เมื่อ</th><th className="px-4 py-2">ผู้ใช้</th><th className="px-4 py-2">สิทธิ์</th><th className="px-4 py-2">การกระทำ</th><th className="px-4 py-2">เหตุผล</th></tr></thead>
          <tbody>{grants.map((g) => <tr key={g.id} className="border-t border-slate-100"><td className="px-4 py-1.5 whitespace-nowrap text-slate-500">{g.created_at}</td><td className="px-4 py-1.5">{g.user_name}</td><td className="px-4 py-1.5">{g.capability === "recorder" ? "เจ้าหน้าที่กรอกผล" : "แพทย์ผู้อนุมัติ"}</td><td className={`px-4 py-1.5 ${g.action === "grant" ? "text-emerald-700" : "text-rose-700"}`}>{g.action === "grant" ? "ให้สิทธิ์" : "ถอนสิทธิ์"}</td><td className="px-4 py-1.5 text-slate-600">{g.reason}</td></tr>)}
            {grants.length === 0 && <tr><td colSpan={5} className="px-4 py-3 text-slate-500">ยังไม่มีประวัติ</td></tr>}</tbody>
        </table>
      </div>
    </div>
  );
}
