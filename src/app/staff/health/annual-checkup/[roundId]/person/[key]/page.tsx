import type { Metadata } from "next";
import { glueCompany } from "@/lib/text";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getSubjectClinical, getExternalDetails, getSubjectDob, getSubjectHeader, isAnnualCheckupInvalid, isApproverUser, listAccessLinks, parseSubjectKey } from "@/lib/annual-checkup-db";
import AccessLinkPanel from "../../../AccessLinkPanel";
import { isUnlocked, requireClinicalUser, unlockExpiry } from "@/lib/annual-checkup-api";
import { fileLink } from "@/lib/annual-checkup-session";
import PersonClient, { type PersonRow } from "../../../PersonClient";
import UnlockPanel from "../../../UnlockPanel";
import SubmitPanel from "../../../SubmitPanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ลงผลตรวจสุขภาพ · NOKHOOK OS PORTAL" };

export default function PersonPage({ params }: { params: { roundId: string; key: string } }) {
  const user = requireClinicalUser();
  const roundId = Number(params.roundId);
  const subject = parseSubjectKey(params.key);
  if (!Number.isInteger(roundId) || roundId <= 0 || !subject) notFound();
  let header: ReturnType<typeof getSubjectHeader>, clinical: ReturnType<typeof getSubjectClinical>;
  try { header = getSubjectHeader(user, roundId, subject); clinical = getSubjectClinical(user, roundId, subject); }
  catch (e) { if (isAnnualCheckupInvalid(e)) notFound(); throw e; }

  // reference ranges from the catalogue (empty until the laboratory's ranges are entered), preferring the person's sex
  const refs = getDb().prepare("SELECT t.code, r.sex, r.low, r.high, r.ref_text FROM annual_checkup_test_refs r JOIN annual_checkup_tests t ON t.id = r.test_id").all() as
    Array<{ code: string; sex: "M" | "F" | "A"; low: number | null; high: number | null; ref_text: string | null }>;
  const defaultRef = (code: string): string => {
    const mine = refs.filter((x) => x.code === code && (x.sex === header.sex || x.sex === "A")).sort((a, b) => (a.sex === header.sex ? -1 : 1) - (b.sex === header.sex ? -1 : 1))[0];
    return mine ? (mine.ref_text ?? (mine.low != null && mine.high != null ? `${mine.low} - ${mine.high}` : mine.low != null ? `≥ ${mine.low}` : mine.high != null ? `≤ ${mine.high}` : "")) : "";
  };
  const rows: PersonRow[] = clinical.results.map((x) => ({
    order_id: x.order_id as number, order_status: x.order_status as PersonRow["order_status"], code: x.code as string, name_th: x.name_th as string, test_unit: (x.test_unit as string | null) ?? null,
    value_kind: x.value_kind as string, waive_reason: (x.waive_reason as string | null) ?? null, external_lab_name: (x.external_lab_name as string | null) ?? null,
    result_id: (x.result_id as number | null) ?? null, revision: (x.revision as number | null) ?? null, result_status: (x.result_status as PersonRow["result_status"]) ?? null,
    value_num: (x.value_num as number | null) ?? null, value_text: (x.value_text as string | null) ?? null, unit: (x.unit as string | null) ?? null, ref_text: (x.ref_text as string | null) ?? null,
    interpretation: (x.interpretation as PersonRow["interpretation"]) ?? null, has_file: (x.has_file as number) ?? 0, verified_at: (x.verified_at as string | null) ?? null, released_at: (x.released_at as string | null) ?? null,
    fileHref: x.has_file && x.result_id ? fileLink(x.result_id as number, user.id) : null, defaultRef: defaultRef(x.code as string)
  }));
  const approver = isApproverUser(user.id);
  const conclusion = clinical.conclusion ? { summary: clinical.conclusion.summary as "normal" | "abnormal" | "follow_up" | null, doctor_comment: clinical.conclusion.doctor_comment as string | null, released_at: clinical.conclusion.released_at as string | null } : null;
  return (
    <div className="space-y-4">
      <Link href={`/staff/health/annual-checkup/${roundId}`} className="text-sm text-slate-500 hover:text-brand min-h-[44px] inline-flex items-center">← กลับรายชื่อ</Link>
      <div className="card space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold text-slate-800">{header.label}</h1>
          {header.kind === "external" && <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-800">ภายนอก</span>}
          {conclusion?.released_at ? <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs text-emerald-800">เปิดผลแล้ว</span> : <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600">ยังไม่เปิดผล</span>}
        </div>
        <p className="text-sm text-slate-500">{header.code ?? "ผู้เข้าตรวจภายนอก (ไม่มีบัญชี)"} · ผู้จ่าย: {header.payer ? glueCompany(header.payer) : "—"}</p>
        <div className="grid gap-2 pt-2 sm:grid-cols-2">
          <Link href={`/staff/health/annual-checkup/${roundId}/person/${params.key}/entry`} className="btn-primary min-h-[48px] inline-flex items-center justify-center text-sm sm:col-span-2">กรอกผลตามหมวดของเล่ม</Link>
          <Link href={`/staff/health/annual-checkup/${roundId}/person/${params.key}/review`} className="btn-secondary min-h-[44px] inline-flex items-center justify-center text-sm">แพทย์ตรวจสอบ / เขียนสรุป</Link>
          {conclusion?.released_at && <a href={`/api/annual-checkup/report-pdf?roundId=${roundId}&subject=${params.key}`} target="_blank" rel="noopener" className="btn-secondary min-h-[44px] inline-flex items-center justify-center text-sm">เล่มผล PDF (A5)</a>}
        </div>
      </div>
      {header.kind === "external" && subject.externalId != null && conclusion?.released_at && (
        <details className="space-y-2"><summary className="cursor-pointer select-none card !py-3 min-h-[44px] flex items-center text-sm font-semibold text-slate-800 list-none">ลิงก์ดูผลสำหรับผู้ที่ไม่มีบัญชี ▾</summary>
          <AccessLinkPanel roundId={roundId} externalId={subject.externalId} links={listAccessLinks(user, roundId, subject.externalId)} hasProof={(() => { const d = getExternalDetails(user, subject.externalId as number); return !!(d?.dob || d?.id_last4) || !!getSubjectDob(user, subject); })()} />
        </details>
      )}
      <SubmitPanel roundId={roundId} subject={params.key} submission={clinical.submission} released={!!conclusion?.released_at}
        allRecorded={rows.filter((x) => x.order_status !== "waived").every((x) => x.result_id != null)} />
      {approver && <UnlockPanel unlockedUntil={unlockExpiry(user)} />}
      <PersonClient rows={rows} roundId={roundId} subject={params.key} externalId={subject.externalId ?? null}
        needsName={header.kind === "external" && /^รอเพิ่มรายชื่อ/.test(header.label)} isApprover={approver} unlocked={isUnlocked(user)} />
    </div>
  );
}
