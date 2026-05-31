import type { Metadata } from "next";
import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { STAGE_META, type ApplicationStage } from "@/lib/recruita";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "RECRUITA · IKIGAI OS" };

// /admin/recruita — landing dashboard for the recruitment module.
// Mirrors the /admin/insigna pattern: top counters + quick links to
// the two main areas (positions + applications) + a small recent
// activity feed.

type StageCount = { stage: ApplicationStage; count: number };

export default function RecruitaLanding() {
  requireSuperAdmin();
  const db = getDb();

  const positionStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'open'   THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'draft'  THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed
    FROM recruita_positions
  `).get() as { total: number; open: number; draft: number; closed: number };

  const stageRows = db.prepare(`
    SELECT stage, COUNT(*) AS count
    FROM recruita_applications
    GROUP BY stage
  `).all() as StageCount[];
  const stageMap = new Map<ApplicationStage, number>(
    stageRows.map((r) => [r.stage, r.count])
  );
  const totalApps = stageRows.reduce((s, r) => s + r.count, 0);

  const recent = db.prepare(`
    SELECT a.id, a.stage, a.submitted_at,
           c.first_name_th, c.last_name_th, c.nickname_th,
           p.title AS position_title, p.code AS position_code
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    JOIN recruita_positions p  ON p.id = a.position_id
    ORDER BY a.submitted_at DESC
    LIMIT 10
  `).all() as Array<{
    id: number; stage: ApplicationStage; submitted_at: string;
    first_name_th: string | null; last_name_th: string | null;
    nickname_th: string | null;
    position_title: string; position_code: string | null;
  }>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">RECRUITA</h1>
        <p className="text-sm text-slate-500">
          ระบบรับสมัครงาน · ภาพรวม pipeline + การจัดการตำแหน่ง
        </p>
      </div>

      {/* Top counters */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <CounterCard label="ตำแหน่งทั้งหมด" value={positionStats.total} />
        <CounterCard label="เปิดรับ" value={positionStats.open ?? 0}
          tone="emerald" />
        <CounterCard label="ใบสมัครทั้งหมด" value={totalApps} />
        <CounterCard label="รอคัดกรอง"
          value={(stageMap.get("applied") ?? 0) + (stageMap.get("screening") ?? 0)}
          tone="amber" />
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Link href="/admin/recruita/positions"
          className="card hover:shadow-md transition group">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">จัดการ</div>
          <h2 className="text-xl font-bold text-slate-800 group-hover:text-brand">
            ตำแหน่งงาน
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            สร้าง / แก้ไข / เปิด-ปิดรับสมัคร + คำถามเฉพาะตำแหน่ง
          </p>
          <p className="mt-3 text-brand text-sm font-bold">→ เปิด</p>
        </Link>
        <Link href="/admin/recruita/applications"
          className="card hover:shadow-md transition group">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">จัดการ</div>
          <h2 className="text-xl font-bold text-slate-800 group-hover:text-brand">
            ใบสมัคร
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            ดูใบสมัครที่เข้ามา · ค้นหา · กรองตามตำแหน่ง/สถานะ
          </p>
          <p className="mt-3 text-brand text-sm font-bold">→ เปิด</p>
        </Link>
      </div>

      {/* Pipeline breakdown */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">Pipeline</h2>
        {totalApps === 0 ? (
          <p className="text-sm text-slate-400 text-center py-4">
            ยังไม่มีใบสมัคร — เปิดตำแหน่งให้พร้อมแล้วแชร์ลิงก์ <code>/recruita/positions</code>
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(["applied", "screening", "interview", "offered", "accepted", "hired", "rejected", "withdrawn"] as const).map((s) => {
              const meta = STAGE_META[s];
              const n = stageMap.get(s) ?? 0;
              return (
                <div key={s} className="border border-slate-200 rounded-lg p-3 text-center">
                  <div className={`inline-block text-[10px] px-2 py-0.5 rounded-full font-bold ${meta.chip}`}>
                    {meta.label}
                  </div>
                  <div className="text-2xl font-bold text-slate-800 mt-1 tabular-nums">{n}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent activity */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">ใบสมัครล่าสุด</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-4">ยังไม่มีใบสมัครเข้ามา</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {recent.map((r) => {
              const meta = STAGE_META[r.stage];
              const name = [r.first_name_th, r.last_name_th].filter(Boolean).join(" ") || "—";
              const nick = r.nickname_th ? ` (${r.nickname_th})` : "";
              return (
                <Link key={r.id} href={`/admin/recruita/applications/${r.id}`}
                  className="block py-2 hover:bg-slate-50 -mx-2 px-2 rounded">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-slate-800 text-sm">#{r.id}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${meta.chip}`}>
                      {meta.label}
                    </span>
                    <span className="text-sm text-slate-700">{name}{nick}</span>
                    <span className="text-xs text-slate-400 ml-auto">
                      {r.submitted_at.slice(0, 16).replace("T", " ")}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {r.position_code ? `[${r.position_code}] ` : ""}{r.position_title}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function CounterCard({
  label, value, tone
}: {
  label: string; value: number;
  tone?: "emerald" | "amber" | "rose";
}) {
  const toneCls = tone === "emerald" ? "text-emerald-700"
    : tone === "amber" ? "text-amber-700"
    : tone === "rose" ? "text-rose-700"
    : "text-slate-800";
  return (
    <div className="card">
      <div className="text-[11px] text-slate-500 uppercase tracking-[1px]">{label}</div>
      <div className={`text-3xl font-bold mt-1 tabular-nums ${toneCls}`}>{value}</div>
    </div>
  );
}
