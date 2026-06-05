import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getProgramStats, type MjActor } from "@/lib/mounjaro-db";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ภาพรวมสุขภาพพนักงาน (HR)" };

// HR / management aggregate view — counts only, NO per-person data. Gated
// to is_hr_analytics or super_admin (both see aggregate; neither sees raw
// clinical rows — enforced by the gateway, which never returns patient
// rows to these actors).
export default function MounjaroHrPage() {
  const user = requireUser();
  if (!(user.is_hr_analytics === 1 || user.role === "super_admin")) {
    redirect("/admin?error=forbidden");
  }
  const s = getProgramStats(user as MjActor);
  const total = s.total_enrolled || 0;
  const pct = (n: number) => (total > 0 ? `${((n / total) * 100).toFixed(0)}%` : "—");

  const cards: Array<{ label: string; value: string; sub?: string }> = [
    { label: "ผู้เข้าร่วมทั้งหมด", value: String(total) },
    { label: "กำลังรักษา (active)", value: String(s.active_count ?? 0), sub: `คงอยู่ ${pct(s.active_count ?? 0)}` },
    { label: "รอตรวจคัดกรอง", value: String(s.pending_count ?? 0) },
    { label: "ออกกลางคัน", value: String(s.withdrawn_count ?? 0), sub: `${pct(s.withdrawn_count ?? 0)}` },
    { label: "จบโครงการ", value: String(s.completed_count ?? 0) }
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ภาพรวมสุขภาพพนักงาน</h1>
        <p className="text-sm text-slate-500">
          สถิติภาพรวมเท่านั้น — ไม่มีข้อมูลรายบุคคล (ตามหลักความเป็นส่วนตัวของข้อมูลสุขภาพ) ·
          ปัจจุบันครอบคลุมโครงการควบคุมน้ำหนัก
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="card">
            <div className="text-xs text-slate-500">{c.label}</div>
            <div className="text-2xl font-bold mt-1 text-slate-800">{c.value}</div>
            {c.sub && <div className="text-[11px] text-slate-400 mt-1">{c.sub}</div>}
          </div>
        ))}
      </div>
      <div className="card flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-slate-500">ดาวน์โหลดสถิติภาพรวม (ไม่มีข้อมูลรายบุคคล)</p>
        <a href="/api/admin/mounjaro-hr/export" download
          className="text-sm px-3 py-1.5 rounded-md bg-white border border-slate-300 text-slate-700 hover:bg-slate-50">
          Export CSV
        </a>
      </div>
      <p className="text-[11px] text-slate-400">
        หมายเหตุ: % น้ำหนักลดเฉลี่ย / อัตรามาตามนัด จะเพิ่มในเฟสถัดไป (คำนวณแบบรวม ไม่ระบุตัวบุคคล)
      </p>
    </div>
  );
}
