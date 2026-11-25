import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { normExamCode } from "@/lib/health-report/lab-import";
import { getRoundLineGaps, getRoundOverview, isAnnualCheckupInvalid, isApproverUser, listMyReturns } from "@/lib/annual-checkup-db";
import { isUnlocked, requireClinicalUser } from "@/lib/annual-checkup-api";
import ReleaseCompany from "./ReleaseCompany";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ผลตรวจสุขภาพประจำปี · NOKHOOK OS PORTAL" };

const FILTERS: Array<{ v: string; th: string }> = [
  { v: "", th: "ทั้งหมด" }, { v: "todo", th: "ยังลงผลไม่ครบ" }, { v: "verify", th: "ส่งแพทย์แล้ว รอตรวจสอบ" }, { v: "release", th: "รอเปิดผล" }, { v: "done", th: "เปิดผลแล้ว" }
];

export default function RoundOverviewPage({ params, searchParams }: { params: { roundId: string }; searchParams: { f?: string; q?: string } }) {
  const user = requireClinicalUser();
  const roundId = Number(params.roundId);
  if (!Number.isInteger(roundId) || roundId <= 0) notFound();
  let data: ReturnType<typeof getRoundOverview>;
  try { data = getRoundOverview(user, roundId); } catch (e) { if (isAnnualCheckupInvalid(e)) notFound(); throw e; }
  const lineGaps = getRoundLineGaps(user, roundId);
  const myReturns = listMyReturns(user, roundId);
  const approver = isApproverUser(user.id);
  const payers = approver ? (getDb().prepare("SELECT id, name_th AS name FROM annual_checkup_payers WHERE round_id = ? ORDER BY id").all(roundId) as Array<{ id: number; name: string }>) : [];
  const f = searchParams.f ?? "";
  const q = (searchParams.q ?? "").trim().toLowerCase();
  // the laboratory's examination code per person (AHC69-0001); a scanned tube label (AHC69-0001-R) is cut back to the code
  const examCode = new Map<string, string>();
  for (const r of getDb().prepare("SELECT user_id, external_id, exam_code FROM annual_checkup_exam_codes WHERE round_id = ?").all(roundId) as Array<{ user_id: number | null; external_id: number | null; exam_code: string }>) examCode.set(r.user_id != null ? `u${r.user_id}` : `e${r.external_id}`, r.exam_code);
  const scanned = q ? normExamCode(q) : "";
  const byScan = scanned ? data.subjects.filter((s) => examCode.get(s.key) === scanned) : [];
  if (byScan.length === 1) redirect(`/staff/health/annual-checkup/${roundId}/person/${byScan[0].key}`);   // scan a tube → open that person
  const subjects = data.subjects.filter((s) => {
    if (q && !`${s.label} ${s.code ?? ""} ${examCode.get(s.key) ?? ""}`.toLowerCase().includes(q)) return false;
    if (f === "todo") return s.recorded < s.required;
    if (f === "verify") return s.recorded === s.required && s.submitted && s.verified < s.required;
    if (f === "release") return s.verified === s.required && s.released < s.required;
    if (f === "done") return s.required > 0 && s.released === s.required;
    return true;
  });
  const state = (s: (typeof data.subjects)[number]) => s.returned ? { th: "ส่งกลับให้แก้ไข", cls: "bg-amber-100 text-amber-800" }
    : s.conclusionReleased && s.required > 0 && s.released < s.required ? { th: "แก้ไขหลังเปิดผล รออนุมัติใหม่", cls: "bg-rose-100 text-rose-700" }
    : s.required > 0 && s.released === s.required ? { th: "เปิดผลแล้ว", cls: "bg-emerald-100 text-emerald-700" }
    : s.verified === s.required && s.required > 0 ? { th: "รอเปิดผล", cls: "bg-sky-100 text-sky-700" }
    : s.recorded === s.required && s.required > 0 ? (s.submitted ? { th: "รอแพทย์ตรวจสอบ", cls: "bg-violet-100 text-violet-700" } : { th: "ลงผลครบ ยังไม่ส่งแพทย์", cls: "bg-indigo-100 text-indigo-700" })
    : s.recorded === 0 ? { th: "ยังไม่ลงผล", cls: "bg-slate-100 text-slate-600" } : { th: "ลงผลบางส่วน", cls: "bg-amber-100 text-amber-800" };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3"><Link href="/staff/health/annual-checkup" className="text-sm text-slate-500 hover:text-brand">← รอบทั้งหมด</Link></div>
      <h1 className="text-xl font-bold text-slate-800">{data.round.name}</h1>
      {lineGaps.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          ผลออกแล้วแต่ยังไม่ได้ผูก LINE จึงไม่ได้รับแจ้ง ({lineGaps.length} คน): {lineGaps.join(", ")} — แจ้งให้เปิดดูผลในพอร์ทัลได้เอง
        </div>
      )}

      <div className="flex flex-wrap gap-2"><Link href={`/staff/health/annual-checkup/${roundId}/overview`} className="btn-secondary text-sm min-h-[44px] leading-[44px] inline-block px-4">ภาพรวมของรอบ (สถานะ งานค้าง รายชื่อติดตาม)</Link></div>
      {myReturns.length > 0 && (
        <div className="card border-amber-300 bg-amber-50 space-y-1">
          <div className="text-sm font-semibold text-amber-900">งานค้างของท่าน: แพทย์ส่งกลับให้แก้ไข ({myReturns.length})</div>
          {myReturns.map((j) => <div key={j.key} className="text-sm"><Link href={`/staff/health/annual-checkup/${roundId}/person/${j.key}/entry`} className="text-brand hover:underline font-medium">{j.label}</Link> — {j.note} <span className="text-xs text-slate-500">({j.by_name})</span></div>)}
        </div>
      )}
      {approver && payers.length > 0 && <ReleaseCompany roundId={roundId} payers={payers} unlocked={isUnlocked(user)} />}

      <div className="card flex flex-wrap items-center gap-3">
        <div className="text-sm text-slate-700">ลงผลรายรายการตามหมวดของเล่ม (เช่น น้ำตาลในเลือด หรือ WBC ของทุกคนต่อกัน)</div>
        <Link href={`/staff/health/annual-checkup/${roundId}/import`} className="btn-secondary text-sm min-h-[44px] leading-[44px] inline-block px-4">นำเข้าผลจากไฟล์แล็บ (Excel)</Link>
        <Link href={`/staff/health/annual-checkup/${roundId}/item/FBS`} className="btn-secondary text-sm min-h-[44px] leading-[44px] inline-block px-4">เปิดหน้ากรอกรายรายการ</Link>
      </div>

      <div className="card overflow-x-auto">
        <div className="text-sm font-semibold text-slate-800">ลงผลรายรายการ (ลงรายการเดียวให้หลายคนพร้อมกัน)</div>
        <table className="w-full text-sm mt-2 min-w-[520px]">
          <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1 pr-3">รายการ</th><th className="py-1 pr-3 text-right">ลงผล</th><th className="py-1 pr-3 text-right">ตรวจสอบ</th><th className="py-1 pr-3 text-right">เปิดผล</th></tr></thead>
          <tbody>
            {data.tests.map((t) => (
              <tr key={t.code} className="border-b border-slate-100 last:border-0">
                <td className="py-1 pr-3"><Link href={`/staff/health/annual-checkup/${roundId}/test/${t.code}`} className="text-brand hover:underline">{t.nameTh}</Link></td>
                <td className="py-1 pr-3 text-right tabular-nums">{t.recorded}/{t.required}</td><td className="py-1 pr-3 text-right tabular-nums">{t.verified}/{t.required}</td><td className="py-1 pr-3 text-right tabular-nums">{t.released}/{t.required}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-slate-800 mr-2">รายคน ({subjects.length})</div>
          <form method="get" className="flex gap-2">
            {f && <input type="hidden" name="f" value={f} />}
            <input name="q" defaultValue={searchParams.q ?? ""} placeholder="ค้นหาชื่อ รหัสพนักงาน หรือสแกนบาร์โค้ดหลอด" autoFocus className="input min-h-[44px] w-56" />
            <button type="submit" className="btn-secondary min-h-[44px] px-4">ค้นหา</button>
          </form>
          {FILTERS.map((x) => <Link key={x.v} href={`?${new URLSearchParams({ ...(x.v ? { f: x.v } : {}), ...(q ? { q } : {}) }).toString()}`} className={`chip ${f === x.v ? "chip-active" : ""}`}>{x.th}</Link>)}
        </div>
        <table className="w-full text-sm mt-2 min-w-[640px]">
          <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1 pr-3">ชื่อ</th><th className="py-1 pr-3">ผู้จ่าย</th><th className="py-1 pr-3 text-right">ลงผล</th><th className="py-1 pr-3 text-right">ตรวจสอบ</th><th className="py-1 pr-3">สถานะ</th></tr></thead>
          <tbody>
            {subjects.map((s) => {
              const st = state(s);
              return (
                <tr key={s.key} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="py-1.5 pr-3"><Link href={`/staff/health/annual-checkup/${roundId}/person/${s.key}`} className="font-medium text-brand hover:underline">{s.label}</Link><div className="text-[11px] text-slate-400">{s.code ?? "ผู้เข้าตรวจภายนอก"}{examCode.get(s.key) ? ` · ${examCode.get(s.key)}` : ""}</div></td>
                  <td className="py-1.5 pr-3 text-xs text-slate-600">{s.payer}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{s.recorded}/{s.required}</td><td className="py-1.5 pr-3 text-right tabular-nums">{s.verified}/{s.required}</td>
                  <td className="py-1.5 pr-3"><span className={`rounded px-1.5 py-0.5 text-[11px] ${st.cls}`}>{st.th}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
