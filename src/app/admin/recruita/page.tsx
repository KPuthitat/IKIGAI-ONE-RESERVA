import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { STAGE_META, type ApplicationStage } from "@/lib/recruita";
import { getRecruitaChannel, isChannelReady } from "@/lib/messaging-channels";
import { formatApplicationNo, formatBkkDateTime } from "@/lib/time";
import { HubCard } from "@/components/HubCard";
import { Icon, type IconName } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "RECRUITA · IKIGAI OS" };

// /admin/recruita — landing dashboard for the recruitment module.
// Mirrors the /admin/insigna pattern: top counters + quick links to
// the two main areas (positions + applications) + a small recent
// activity feed.

type StageCount = { stage: ApplicationStage; count: number };

export default function RecruitaLanding() {
  requireAdmin();
  const lang = getLang();
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
           (SELECT COUNT(*) FROM recruita_applications za
             WHERE date(za.submitted_at, '+7 hours') = date(a.submitted_at, '+7 hours')
               AND za.id <= a.id) AS day_seq,
           c.title_prefix, c.first_name_th, c.last_name_th, c.nickname_th,
           p.title AS position_title, p.code AS position_code
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    JOIN recruita_positions p  ON p.id = a.position_id
    ORDER BY a.submitted_at DESC
    LIMIT 10
  `).all() as Array<{
    id: number; stage: ApplicationStage; submitted_at: string; day_seq: number;
    title_prefix: string | null;
    first_name_th: string | null; last_name_th: string | null;
    nickname_th: string | null;
    position_title: string; position_code: string | null;
  }>;

  // Upcoming interviews (today onward) — a lightweight "calendar".
  // interview_at is a naive Bangkok-local "YYYY-MM-DDTHH:MM" so we
  // compare against the start of today in Bangkok.
  const todayBkk = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const interviews = db.prepare(`
    SELECT a.id, a.interview_at, a.interview_location,
           c.title_prefix, c.first_name_th, c.last_name_th, c.nickname_th,
           p.title AS position_title, b.name AS branch_name
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    JOIN recruita_positions p  ON p.id = a.position_id
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE a.interview_at IS NOT NULL AND a.interview_at >= ?
    ORDER BY a.interview_at ASC
    LIMIT 10
  `).all(`${todayBkk}T00:00`) as Array<{
    id: number; interview_at: string; interview_location: string | null;
    title_prefix: string | null;
    first_name_th: string | null; last_name_th: string | null;
    nickname_th: string | null;
    position_title: string; branch_name: string | null;
  }>;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            RECRUITA · <span className="font-medium text-slate-600">{t(lang, "admin.recruita.title")}</span>
          </h1>
          <p className="text-sm text-slate-500">
            {t(lang, "admin.recruita.subtitle")}
          </p>
        </div>
        <Link href="/admin/recruita/settings"
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
          <Icon name="settings" className="h-3.5 w-3.5" />
          {t(lang, "admin.recruita.nav.settings")}
          {isChannelReady(getRecruitaChannel()) ? (
            <Icon name="check" className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.5} />
          ) : (
            <Icon name="alert" className="h-3.5 w-3.5 text-amber-600" />
          )}
        </Link>
      </div>

      {/* Top counters */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <CounterCard label="ตำแหน่งทั้งหมด" value={positionStats.total} icon="briefcase" />
        <CounterCard label="เปิดรับ" value={positionStats.open ?? 0} tone="emerald" icon="check" />
        <CounterCard label="ใบสมัครทั้งหมด" value={totalApps} icon="doc" />
        <CounterCard label="รอคัดกรอง"
          value={(stageMap.get("applied") ?? 0) + (stageMap.get("screening") ?? 0)}
          tone="amber" icon="clock" />
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <HubCard href="/admin/recruita/positions" icon="briefcase" tone="brand"
          eyebrow="จัดการ" title="ตำแหน่งงาน"
          sub="สร้าง / แก้ไข / เปิด-ปิดรับสมัคร + คำถามเฉพาะตำแหน่ง" cta="เปิด →" />
        <HubCard href="/admin/recruita/pipeline" icon="list" tone="emerald"
          eyebrow="มุมมอง" title="Pipeline"
          sub="Kanban · ลากการ์ดระหว่าง stage · ภาพรวม pipeline ทั้งหมด" cta="เปิด →" />
        <HubCard href="/admin/recruita/applications" icon="doc" tone="slate"
          eyebrow="จัดการ" title="ใบสมัคร"
          sub="List view · ค้นหา · กรองตามตำแหน่ง/สถานะ" cta="เปิด →" />
        <HubCard href="/admin/recruita/dashboard" icon="chart" tone="sky"
          eyebrow="วิเคราะห์" title="Analytics"
          sub="Funnel · Source attribution · Time-to-hire · Fill rate" cta="เปิด →" />
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

      {/* Upcoming interviews — lightweight calendar */}
      {interviews.length > 0 && (
        <div className="card space-y-2">
          <h2 className="font-bold text-slate-800 text-sm">นัดสัมภาษณ์ที่จะถึง</h2>
          <div className="divide-y divide-slate-100">
            {interviews.map((iv) => {
              const name = [iv.title_prefix, iv.first_name_th, iv.last_name_th]
                .filter(Boolean).join(" ") || "—";
              const nick = iv.nickname_th ? ` (${iv.nickname_th})` : "";
              return (
                <Link key={iv.id} href={`/admin/recruita/applications/${iv.id}`}
                  className="block py-2 hover:bg-slate-50 -mx-2 px-2 rounded">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                      {iv.interview_at.replace("T", " ")} น.
                    </span>
                    <span className="text-sm text-slate-700">{name}{nick}</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {iv.position_title}
                    {iv.branch_name && <> · <span className="font-semibold text-slate-700">{iv.branch_name}</span></>}
                    {iv.interview_location && <> · {iv.interview_location}</>}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent activity */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">ใบสมัครล่าสุด</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-4">ยังไม่มีใบสมัครเข้ามา</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {recent.map((r) => {
              const meta = STAGE_META[r.stage];
              const name = [r.title_prefix, r.first_name_th, r.last_name_th]
                .filter(Boolean).join(" ") || "—";
              const nick = r.nickname_th ? ` (${r.nickname_th})` : "";
              return (
                <Link key={r.id} href={`/admin/recruita/applications/${r.id}`}
                  className="block py-2 hover:bg-slate-50 -mx-2 px-2 rounded">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-slate-800 text-sm font-mono">{formatApplicationNo(r.submitted_at, r.day_seq)}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${meta.chip}`}>
                      {meta.label}
                    </span>
                    <span className="text-sm text-slate-700">{name}{nick}</span>
                    <span className="text-xs text-slate-400 ml-auto">
                      {formatBkkDateTime(r.submitted_at)}
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
  label, value, tone, icon
}: {
  label: string; value: number;
  tone?: "emerald" | "amber" | "rose";
  icon: IconName;
}) {
  const toneCls = tone === "emerald" ? "text-emerald-700"
    : tone === "amber" ? "text-amber-700"
    : tone === "rose" ? "text-rose-700"
    : "text-slate-800";
  const tileCls = tone === "emerald" ? "bg-emerald-50 text-emerald-600"
    : tone === "amber" ? "bg-amber-50 text-amber-600"
    : tone === "rose" ? "bg-rose-50 text-rose-600"
    : "bg-slate-100 text-slate-500";
  return (
    <div className="card">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-slate-500 uppercase tracking-[1px]">{label}</div>
        <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${tileCls}`}>
          <Icon name={icon} className="h-4 w-4" />
        </span>
      </div>
      <div className={`text-3xl font-bold mt-1 tabular-nums ${toneCls}`}>{value}</div>
    </div>
  );
}
