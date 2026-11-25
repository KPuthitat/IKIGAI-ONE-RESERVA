import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getFollowUpForHr, getProgress, isAnnualCheckupForbidden, type ProgressState } from "@/lib/annual-checkup-db";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ความคืบหน้าตรวจสุขภาพประจำปี · PERSONA" };

// /admin/annual-checkup-status — HR / admin / owner see HOW MANY people are at each stage, never who has which result. The gateway
// returns counts only (no names, no tests, no values), so this page cannot show more even by mistake.
const STATES: Array<{ k: ProgressState; th: string; cls: string }> = [
  { k: "not_checked", th: "ยังไม่ตรวจ", cls: "bg-slate-100 text-slate-700" },
  { k: "checked", th: "ตรวจแล้วบางส่วน", cls: "bg-amber-100 text-amber-800" },
  { k: "awaiting_result", th: "รอผล", cls: "bg-sky-100 text-sky-700" },
  { k: "released", th: "ผลออกแล้ว", cls: "bg-emerald-100 text-emerald-700" }
];

export default function CheckupStatusPage({ searchParams }: { searchParams: { round?: string } }) {
  const user = requireUser();
  const rounds = getDb().prepare("SELECT id, name FROM annual_checkup_rounds ORDER BY id DESC").all() as Array<{ id: number; name: string }>;
  const chosen = rounds.find((r) => String(r.id) === searchParams.round) ?? rounds[0];
  let progress: ReturnType<typeof getProgress> | null = null;
  let followUp: ReturnType<typeof getFollowUpForHr> = [];
  try { if (chosen) { progress = getProgress(user, chosen.id); followUp = getFollowUpForHr(user, chosen.id); } }
  catch (e) { if (isAnnualCheckupForbidden(e)) redirect("/admin?error=forbidden"); throw e; }
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ความคืบหน้าตรวจสุขภาพประจำปี</h1>
        <p className="text-sm text-slate-500">แสดงเฉพาะจำนวนคน ไม่แสดงรายชื่อ ผลตรวจ หรือเหตุผลการงดตรวจ</p>
      </div>
      {rounds.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {rounds.map((r) => <Link key={r.id} href={`/admin/annual-checkup-status?round=${r.id}`} className={chosen && r.id === chosen.id ? "btn-primary text-sm" : "btn-secondary text-sm"}>{r.name}</Link>)}
        </div>
      )}
      {!chosen || !progress ? <div className="card p-4 text-sm text-slate-600">ยังไม่มีรอบตรวจ</div> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="card p-3"><div className="text-xs text-slate-500">ผู้เข้าตรวจทั้งหมด</div><div className="text-2xl font-bold text-slate-800">{progress.total}</div></div>
            {STATES.map((s) => <div key={s.k} className="card p-3"><div className={`inline-block px-2 py-0.5 rounded-full text-xs ${s.cls}`}>{s.th}</div><div className="text-2xl font-bold text-slate-800 mt-1">{progress!.byState[s.k]}</div></div>)}
          </div>
          <div className="card overflow-x-auto">
            <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-800">แยกตามบริษัทผู้จ่าย</div>
            <table className="w-full text-sm min-w-[560px]">
              <thead className="text-left text-slate-500"><tr><th className="px-4 py-2">บริษัทผู้จ่าย</th><th className="px-4 py-2 text-right">ทั้งหมด</th>{STATES.map((s) => <th key={s.k} className="px-4 py-2 text-right">{s.th}</th>)}</tr></thead>
              <tbody>
                {progress.byPayer.map((p) => (
                  <tr key={p.payer} className="border-t border-slate-100"><td className="px-4 py-2 text-slate-800">{p.payer}</td><td className="px-4 py-2 text-right">{p.total}</td>{STATES.map((s) => <td key={s.k} className="px-4 py-2 text-right">{p.byState[s.k]}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card overflow-x-auto">
            <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-800">รายชื่อที่ต้องติดตาม (เฉพาะผู้ที่ยินยอมให้ฝ่ายบุคคลเห็น)</div>
            <p className="px-4 pt-2 text-xs text-slate-500">แสดงเฉพาะชื่อและภาพรวม ไม่แสดงค่าผลตรวจ พนักงานเลือกเองได้ที่หน้าผลตรวจของตน คนที่ไม่ได้ยินยอมจะไม่อยู่ในรายการนี้ แต่ยังนับรวมในจำนวนด้านบน</p>
            <table className="w-full text-sm min-w-[480px]"><thead className="text-left text-slate-500"><tr><th className="px-4 py-2">ชื่อ</th><th className="px-4 py-2">บริษัทผู้จ่าย</th><th className="px-4 py-2">ภาพรวม</th><th className="px-4 py-2" /></tr></thead>
              <tbody>{followUp.map((f) => <tr key={f.user_id} className="border-t border-slate-100"><td className="px-4 py-2">{f.name}</td><td className="px-4 py-2">{f.payer}</td><td className="px-4 py-2">{f.verdict}</td><td className="px-4 py-2 text-right"><Link className="text-brand underline text-xs" href={`/admin/annual-checkup-status/person/${chosen.id}/${f.user_id}`}>ดูผล (ถ้าได้รับอนุญาต)</Link></td></tr>)}
                {followUp.length === 0 && <tr><td colSpan={4} className="px-4 py-3 text-slate-500">ไม่มีรายชื่อที่ยินยอมให้แสดง</td></tr>}</tbody></table>
          </div>
        </>
      )}
    </div>
  );
}
