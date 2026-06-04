import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import AccessClient, { type AccessRow } from "./AccessClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สิทธิ์ทางคลินิก Mounjaro · ผู้ดูแลระบบ" };

// super_admin grants Mounjaro clinical access (แพทย์ / พยาบาล / HR) so no
// one has to touch SQL. Doctors get a license number that unlocks their
// (own) patients; nurses get no clinical view; HR sees aggregate only.
export default function MounjaroAccessPage() {
  requireSuperAdmin();
  const rows = getDb().prepare(`
    SELECT id, username, display_name, title_prefix, role,
           clinical_role, license_no, is_hr_analytics
    FROM users
    WHERE status = 'active' AND is_test_account = 0
    ORDER BY display_name
  `).all() as AccessRow[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">สิทธิ์ทางคลินิก — โครงการ Mounjaro</h1>
        <p className="text-sm text-slate-500">
          กำหนดว่าใครเป็น <b>แพทย์</b> (เห็นเฉพาะคนไข้ของตัวเอง · ปลดล็อกด้วยเลขใบประกอบ),
          <b> พยาบาล</b> (ไม่เห็นข้อมูลคลินิกในเฟสนี้), หรือ <b>HR</b> (เห็นภาพรวมเท่านั้น)
        </p>
      </div>
      <AccessClient rows={rows} />
    </div>
  );
}
