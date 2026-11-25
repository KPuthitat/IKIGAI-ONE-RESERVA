import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRoundDashboard, isAnnualCheckupInvalid } from "@/lib/annual-checkup-db";
import { requireClinicalUser } from "@/lib/annual-checkup-api";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ภาพรวมรอบตรวจสุขภาพ · NOKHOOK OS PORTAL" };

const STATE_TH: Array<{ k: keyof ReturnType<typeof getRoundDashboard>["states"]; th: string; cls: string }> = [
  { k: "not_recorded", th: "ยังไม่ลงผล", cls: "bg-slate-100 text-slate-700" }, { k: "partial", th: "ลงผลบางส่วน", cls: "bg-amber-100 text-amber-800" },
  { k: "to_send", th: "ลงครบ ยังไม่ส่งแพทย์", cls: "bg-indigo-100 text-indigo-700" }, { k: "awaiting_doctor", th: "รอแพทย์ตรวจสอบ", cls: "bg-violet-100 text-violet-700" },
  { k: "returned", th: "ส่งกลับให้แก้ไข", cls: "bg-amber-100 text-amber-800" }, { k: "to_release", th: "รอเปิดผล", cls: "bg-sky-100 text-sky-700" },
  { k: "released", th: "เปิดผลแล้ว", cls: "bg-emerald-100 text-emerald-700" }, { k: "revised", th: "แก้ไขหลังเปิดผล รออนุมัติใหม่", cls: "bg-rose-100 text-rose-700" }
];

export default function OverviewPage({ params }: { params: { roundId: string } }) {
  const user = requireClinicalUser();
  const roundId = Number(params.roundId);
  if (!Number.isInteger(roundId) || roundId <= 0) notFound();
  let d: ReturnType<typeof getRoundDashboard>;
  try { d = getRoundDashboard(user, roundId); } catch (e) { if (isAnnualCheckupInvalid(e)) notFound(); throw e; }
  return (
    <div className="space-y-4">
      <Link href={`/staff/health/annual-checkup/${roundId}`} className="text-sm text-slate-500 hover:text-brand">← กลับรายชื่อ</Link>
      <h1 className="text-xl font-bold text-slate-800">ภาพรวม · {d.round.name}</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card p-3"><div className="text-xs text-slate-500">ผู้เข้ารับการตรวจทั้งหมด</div><div className="text-2xl font-bold tabular-nums">{d.total}</div></div>
        {STATE_TH.map((s) => <div key={s.k} className="card p-3"><span className={`inline-block px-2 py-0.5 rounded-full text-xs ${s.cls}`}>{s.th}</span><div className="text-2xl font-bold tabular-nums mt-1">{d.states[s.k]}</div></div>)}
      </div>
      <div className="card overflow-x-auto">
        <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-800">แยกตามบริษัทผู้จ่าย</div>
        <table className="w-full text-sm min-w-[480px]"><thead className="text-left text-slate-500"><tr><th className="px-4 py-2">บริษัท</th><th className="px-4 py-2 text-right">คน</th><th className="px-4 py-2 text-right">รอแพทย์</th><th className="px-4 py-2 text-right">เปิดผลแล้ว</th></tr></thead>
          <tbody>{d.byPayer.map((p) => <tr key={p.payer} className="border-t border-slate-100"><td className="px-4 py-2">{p.payer}</td><td className="px-4 py-2 text-right tabular-nums">{p.total}</td><td className="px-4 py-2 text-right tabular-nums">{p.awaiting_doctor}</td><td className="px-4 py-2 text-right tabular-nums">{p.released}</td></tr>)}</tbody></table>
      </div>
      <div className="card overflow-x-auto">
        <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-800">งานค้างของแต่ละคน</div>
        <table className="w-full text-sm min-w-[420px]"><thead className="text-left text-slate-500"><tr><th className="px-4 py-2">ผู้ลงผล / แพทย์</th><th className="px-4 py-2 text-right">ถูกส่งกลับ (รอแก้)</th><th className="px-4 py-2 text-right">ส่งแพทย์ไปแล้ว</th></tr></thead>
          <tbody>{d.byRecorder.map((r) => <tr key={r.name} className="border-t border-slate-100"><td className="px-4 py-2">{r.name}</td><td className={`px-4 py-2 text-right tabular-nums ${r.returned ? "text-amber-700 font-semibold" : ""}`}>{r.returned}</td><td className="px-4 py-2 text-right tabular-nums">{r.sent}</td></tr>)}
            {d.byRecorder.length === 0 && <tr><td colSpan={3} className="px-4 py-3 text-slate-500">ยังไม่มีงานค้าง</td></tr>}</tbody></table>
      </div>
      <div className="card overflow-x-auto">
        <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-800">รายชื่อที่ต้องติดตาม ({d.followUp.length})</div>
        <table className="w-full text-sm min-w-[480px]"><thead className="text-left text-slate-500"><tr><th className="px-4 py-2">ชื่อ</th><th className="px-4 py-2">บริษัท</th><th className="px-4 py-2">สรุปของแพทย์</th><th className="px-4 py-2">เปิดผลแล้ว</th></tr></thead>
          <tbody>{d.followUp.map((f) => <tr key={f.key} className="border-t border-slate-100"><td className="px-4 py-2"><Link className="text-brand hover:underline" href={`/staff/health/annual-checkup/${roundId}/person/${f.key}/review`}>{f.label}</Link></td><td className="px-4 py-2">{f.payer}</td><td className="px-4 py-2">{f.summary}</td><td className="px-4 py-2">{f.released ? "✓" : "—"}</td></tr>)}
            {d.followUp.length === 0 && <tr><td colSpan={4} className="px-4 py-3 text-slate-500">ยังไม่มี</td></tr>}</tbody></table>
      </div>
    </div>
  );
}
