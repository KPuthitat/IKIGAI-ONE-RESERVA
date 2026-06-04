import Link from "next/link";
import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth";
import { listRbacRoles } from "@/lib/db";
import { RBAC_PERMISSIONS } from "@/lib/rbac";
import RolesClient from "./RolesClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "บทบาทและสิทธิ์ · IKIGAI OS" };

// /admin/roles — RBAC role manager (super_admin only). Create roles,
// tick which modules each can access, then assign roles to people in
// the employee edit page (PERSONA → พนักงาน). System roles can be
// renamed / re-permissioned but not deleted.
export default function RolesPage() {
  requireSuperAdmin();
  const roles = listRbacRoles();

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">บทบาทและสิทธิ์</h1>
        <p className="text-sm text-slate-500 mt-1">
          สร้างบทบาทและกำหนดว่าบทบาทนั้นเข้าถึงโมดูลใดได้บ้าง จากนั้นไป
          กำหนดบทบาทให้พนักงานที่หน้า PERSONA → พนักงาน → แก้ไข
        </p>
      </div>

      {/* PDPA note — clarify the scope so the owner doesn't expect this
          to control salary/clinical access (those stay separate). */}
      <div className="card bg-amber-50 border border-amber-200 text-[13px] text-amber-900">
        บทบาทนี้ควบคุม <b>สิทธิ์เข้าโมดูลผู้ดูแล</b> (PERSONA / RESERVA / RECRUITA /
        INSIGNA / ASCENDA) เท่านั้น · สิทธิ์ดู<b>เงินเดือน</b>,
        <b> ข้อมูลคลินิก (แพทย์/พยาบาล)</b> และ <b>ภาพรวม HR</b> ยังตั้งแยกในหน้า
        พนักงานเหมือนเดิม (ข้อมูลอ่อนไหว) · ผู้ดูแลระบบสูงสุด (superadmin)
        เข้าได้ทุกอย่างเสมอ
      </div>

      <RolesClient roles={roles} catalog={RBAC_PERMISSIONS} />
    </div>
  );
}
