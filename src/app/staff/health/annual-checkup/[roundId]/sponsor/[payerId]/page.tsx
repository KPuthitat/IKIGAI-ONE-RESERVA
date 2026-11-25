import type { Metadata } from "next";
import { glueCompany } from "@/lib/text";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSponsorSummary, isAnnualCheckupInvalid, READINESS_TH } from "@/lib/annual-checkup-db";
import { requireClinicalUser } from "@/lib/annual-checkup-api";
import PrintButton from "../../person/[key]/report/PrintButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สรุปสถานะการตรวจสำหรับบริษัท · NOKHOOK OS PORTAL" };

// For the paying company: how many people, how many are done, how many are ready — never a person's lab values, unless that person agreed
// (and then only released values). Print → Save as PDF to hand it over. Owner 2026-11-25.
const STAGE_TH = { not_started: "ยังไม่เริ่มตรวจ", in_progress: "อยู่ระหว่างตรวจ", complete: "ตรวจครบ รอแพทย์สรุป", released: "ออกผลแล้ว" } as const;

export default function SponsorSummaryPage({ params }: { params: { roundId: string; payerId: string } }) {
  const user = requireClinicalUser();
  const roundId = Number(params.roundId), payerId = Number(params.payerId);
  if (!Number.isInteger(roundId) || roundId <= 0 || !Number.isInteger(payerId) || payerId <= 0) notFound();
  let s: ReturnType<typeof getSponsorSummary>;
  try { s = getSponsorSummary(user, roundId, payerId); } catch (e) { if (isAnnualCheckupInvalid(e)) notFound(); throw e; }
  const today = new Date().toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Bangkok" });
  return (
    <div className="space-y-3">
      <div className="flex gap-3 items-center print:hidden">
        <Link href={`/staff/health/annual-checkup/${roundId}`} className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
        <PrintButton />
      </div>
      <article className="bg-white mx-auto max-w-[210mm] p-[14mm] text-[13px] leading-relaxed text-slate-900 border border-slate-200 print:border-0 print:p-0">
        <h1 className="text-lg font-bold text-center">สรุปสถานะการตรวจสุขภาพประจำปี</h1>
        <p className="text-center text-slate-600">{s.round.name} · {glueCompany(s.payer.name)}</p>
        <p className="text-center text-xs text-slate-500">ข้อมูล ณ วันที่ {today}</p>
        <div className="mt-4 grid grid-cols-4 gap-2 text-center">
          {[["ผู้เข้ารับการตรวจ", s.counts.total], ["ตรวจครบแล้ว", s.counts.resultsComplete], ["ออกผลแล้ว", s.counts.released], ["ยังไม่เสร็จ", s.counts.pending]].map(([l, v]) => (
            <div key={l as string} className="rounded border border-slate-300 py-2"><div className="text-[11px] text-slate-500">{l}</div><div className="text-xl font-bold tabular-nums">{v}</div></div>
          ))}
        </div>
        <h2 className="mt-4 font-semibold">ความพร้อมในการปฏิบัติงาน (ตามสรุปของแพทย์ จากผลที่ออกแล้ว)</h2>
        <ul className="text-sm mt-1">
          {(Object.keys(READINESS_TH) as Array<keyof typeof READINESS_TH>).map((k) => <li key={k}>{READINESS_TH[k]}: <b className="tabular-nums">{s.counts.readiness[k]}</b> คน</li>)}
        </ul>
        <table className="w-full mt-4 text-sm border-collapse">
          <thead><tr className="border-b border-slate-400 text-left"><th className="py-1 pr-2 w-8">#</th><th className="py-1 pr-2">ชื่อ</th><th className="py-1 pr-2">สถานะ</th><th className="py-1">ความพร้อม</th></tr></thead>
          <tbody>
            {s.people.map((p, i) => (
              <tr key={i} className="border-b border-slate-200 align-top">
                <td className="py-1 pr-2 tabular-nums">{i + 1}</td><td className="py-1 pr-2">{p.label}</td><td className="py-1 pr-2">{STAGE_TH[p.stage]}</td>
                <td className="py-1">{p.readiness ? READINESS_TH[p.readiness] : "—"}
                  {p.sharedValues && p.sharedValues.length > 0 && <div className="text-xs text-slate-600">ผู้รับการตรวจยินยอมให้เปิดเผยค่า: {p.sharedValues.map((v) => `${v.test} ${v.value}`).join(" · ")}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-4 text-xs text-slate-500">เอกสารนี้แสดงเฉพาะสถานะและความพร้อม ไม่แสดงผลตรวจรายบุคคล เว้นแต่ผู้รับการตรวจให้ความยินยอมไว้ ผลตรวจฉบับเต็มส่งให้ผู้รับการตรวจโดยตรงเท่านั้น</p>
      </article>
    </div>
  );
}
