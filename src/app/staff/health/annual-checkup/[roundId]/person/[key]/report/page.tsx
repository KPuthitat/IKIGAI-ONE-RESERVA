import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getExternalReport, isAnnualCheckupInvalid, parseSubjectKey } from "@/lib/annual-checkup-db";
import { requireClinicalUser } from "@/lib/annual-checkup-api";
import PrintButton from "./PrintButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "รายงานผลตรวจสุขภาพ · NOKHOOK OS PORTAL" };

// Printable A4 report for a person without an account, made by clinical staff after the doctor has released the results.
// "Print → Save as PDF" gives the file to send to the paying company; the person never gets a login.
const INTERP_TH: Record<string, string> = { normal: "ปกติ", abnormal: "ผิดปกติ", follow_up: "ต้องติดตาม" };
const day = (iso: string) => new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Bangkok" });
function show(r: Record<string, unknown>): string {
  if (r.value_num != null) return `${r.value_num}${r.unit ? ` ${r.unit}` : ""}`;
  if (typeof r.value_text === "string" && r.value_text) return r.value_text;
  if (typeof r.value_json === "string" && r.value_json) {
    try { return Object.entries(JSON.parse(r.value_json) as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`).join("\n"); } catch { return r.value_json; }
  }
  return "—";
}

export default function ExternalReportPage({ params }: { params: { roundId: string; key: string } }) {
  const user = requireClinicalUser();
  const roundId = Number(params.roundId);
  const subject = parseSubjectKey(params.key);
  if (!Number.isInteger(roundId) || roundId <= 0 || !subject || subject.externalId == null) notFound();
  let rep: ReturnType<typeof getExternalReport>;
  try { rep = getExternalReport(user, roundId, subject.externalId); }
  catch (e) { if (isAnnualCheckupInvalid(e)) notFound(); throw e; }
  return (
    <div className="space-y-3">
      <div className="flex gap-3 items-center print:hidden">
        <Link href={`/staff/health/annual-checkup/${roundId}/person/${params.key}`} className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
        <PrintButton />
      </div>
      <article className="bg-white mx-auto max-w-[210mm] p-[14mm] text-[13px] leading-relaxed text-slate-900 border border-slate-200 print:border-0 print:p-0">
        <h1 className="text-lg font-bold text-center">รายงานผลตรวจสุขภาพประจำปี</h1>
        <p className="text-center text-slate-600">{rep.round.name}</p>
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1">
          <div><b>ชื่อ-สกุล:</b> {rep.person.label}</div>
          <div><b>บริษัท:</b> {rep.person.payer}</div>
          <div><b>เพศ:</b> {rep.person.sex === "M" ? "ชาย" : rep.person.sex === "F" ? "หญิง" : "—"}</div>
          <div><b>วันเกิด:</b> {rep.person.dob ? day(rep.person.dob) : "—"}</div>
        </div>
        <table className="w-full mt-4 border-collapse">
          <thead><tr className="bg-slate-100 text-left"><th className="border border-slate-300 px-2 py-1">รายการตรวจ</th><th className="border border-slate-300 px-2 py-1">ผล</th><th className="border border-slate-300 px-2 py-1">ค่าอ้างอิง</th><th className="border border-slate-300 px-2 py-1">การแปลผล</th></tr></thead>
          <tbody>
            {rep.results.map((r) => (
              <tr key={r.code as string} className="align-top">
                <td className="border border-slate-300 px-2 py-1">{r.name_th as string}</td>
                <td className="border border-slate-300 px-2 py-1 whitespace-pre-line">{show(r)}</td>
                <td className="border border-slate-300 px-2 py-1">{(r.ref_text as string | null) || "—"}</td>
                <td className="border border-slate-300 px-2 py-1">{r.interpretation ? INTERP_TH[r.interpretation as string] : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-4"><b>สรุปผล:</b> {rep.conclusion.summary ? INTERP_TH[rep.conclusion.summary] : "—"}</div>
        <div className="mt-1 whitespace-pre-line"><b>ความเห็นแพทย์:</b> {rep.conclusion.doctor_comment || "—"}</div>
        <div className="mt-10 text-right">
          <div>ลงชื่อ ........................................</div>
          <div>{rep.conclusion.doctor ?? "แพทย์ผู้ตรวจ"}{rep.conclusion.license_no ? ` · ใบอนุญาตเลขที่ ${rep.conclusion.license_no}` : ""}</div>
          <div className="text-slate-600">วันที่เปิดผล {day(rep.conclusion.released_at)}</div>
        </div>
      </article>
    </div>
  );
}
