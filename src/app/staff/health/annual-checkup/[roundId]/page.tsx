import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRoundLineGaps, getRoundOverview, isAnnualCheckupInvalid } from "@/lib/annual-checkup-db";
import { requireClinicalUser } from "@/lib/annual-checkup-api";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ผลตรวจสุขภาพประจำปี · NOKHOOK OS PORTAL" };

const FILTERS: Array<{ v: string; th: string }> = [
  { v: "", th: "ทั้งหมด" }, { v: "todo", th: "ยังลงผลไม่ครบ" }, { v: "verify", th: "ส่งแพทย์แล้ว รอตรวจสอบ" }, { v: "release", th: "รอเปิดผล" }, { v: "done", th: "เปิดผลแล้ว" }
];

export default function RoundOverviewPage({ params, searchParams }: { params: { roundId: string }; searchParams: { f?: string } }) {
  const user = requireClinicalUser();
  const roundId = Number(params.roundId);
  if (!Number.isInteger(roundId) || roundId <= 0) notFound();
  let data: ReturnType<typeof getRoundOverview>;
  try { data = getRoundOverview(user, roundId); } catch (e) { if (isAnnualCheckupInvalid(e)) notFound(); throw e; }
  const lineGaps = getRoundLineGaps(user, roundId);
  const f = searchParams.f ?? "";
  const subjects = data.subjects.filter((s) => {
    if (f === "todo") return s.recorded < s.required;
    if (f === "verify") return s.recorded === s.required && s.submitted && s.verified < s.required;
    if (f === "release") return s.verified === s.required && s.released < s.required;
    if (f === "done") return s.required > 0 && s.released === s.required;
    return true;
  });
  const state = (s: (typeof data.subjects)[number]) => s.required > 0 && s.released === s.required ? { th: "เปิดผลแล้ว", cls: "bg-emerald-100 text-emerald-700" }
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
          {FILTERS.map((x) => <Link key={x.v} href={x.v ? `?f=${x.v}` : "?"} className={`chip ${f === x.v ? "chip-active" : ""}`}>{x.th}</Link>)}
        </div>
        <table className="w-full text-sm mt-2 min-w-[640px]">
          <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1 pr-3">ชื่อ</th><th className="py-1 pr-3">ผู้จ่าย</th><th className="py-1 pr-3 text-right">ลงผล</th><th className="py-1 pr-3 text-right">ตรวจสอบ</th><th className="py-1 pr-3">สถานะ</th></tr></thead>
          <tbody>
            {subjects.map((s) => {
              const st = state(s);
              return (
                <tr key={s.key} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="py-1.5 pr-3"><Link href={`/staff/health/annual-checkup/${roundId}/person/${s.key}`} className="font-medium text-brand hover:underline">{s.label}</Link><div className="text-[11px] text-slate-400">{s.code ?? "ผู้เข้าตรวจภายนอก"}</div></td>
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
