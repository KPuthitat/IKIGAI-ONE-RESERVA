import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getOpenReturn, getSectionNotes, getSubjectClinical, getSubjectDob, getSubjectHeader, isAnnualCheckupInvalid, isApproverUser, parseSubjectKey } from "@/lib/annual-checkup-db";
import { isUnlocked, requireClinicalUser, unlockExpiry } from "@/lib/annual-checkup-api";
import { fileLink } from "@/lib/annual-checkup-session";
import { ageOn } from "@/lib/health-report/interpret";
import { loadItems } from "@/lib/health-report/store";
import { buildTabs } from "@/lib/health-report/tabs";
import UnlockPanel from "../../../../UnlockPanel";
import ReviewClient from "./ReviewClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "แพทย์ตรวจสอบผล · NOKHOOK OS PORTAL" };

export default function ReviewPage({ params }: { params: { roundId: string; key: string } }) {
  const user = requireClinicalUser();
  const roundId = Number(params.roundId);
  const subject = parseSubjectKey(params.key);
  if (!Number.isInteger(roundId) || roundId <= 0 || !subject) notFound();
  let header: ReturnType<typeof getSubjectHeader>, clinical: ReturnType<typeof getSubjectClinical>, dob: string | null, notes: ReturnType<typeof getSectionNotes>, open: ReturnType<typeof getOpenReturn>;
  try { header = getSubjectHeader(user, roundId, subject); clinical = getSubjectClinical(user, roundId, subject); dob = getSubjectDob(user, subject); notes = getSectionNotes(user, roundId, subject); open = getOpenReturn(user, roundId, subject); }
  catch (e) { if (isAnnualCheckupInvalid(e)) notFound(); throw e; }
  const db = getDb();
  const tabs = buildTabs(clinical.results, loadItems(db).filter((i) => !i.hidden), (id) => fileLink(id, user.id));
  const templates = db.prepare("SELECT section, kind, text FROM annual_checkup_note_templates WHERE active = 1 ORDER BY sort_no, id").all() as Array<{ section: string; kind: "summary" | "recommendation"; text: string }>;
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const approver = isApproverUser(user.id);
  const concl = clinical.conclusion as { summary: "normal" | "abnormal" | "follow_up" | null; doctor_comment: string | null; released_at: string | null } | null;
  const required = clinical.results.filter((r) => r.order_status !== "waived");
  return (
    <div className="space-y-4">
      <Link href={`/staff/health/annual-checkup/${roundId}/person/${params.key}`} className="text-sm text-slate-500 hover:text-brand">← กลับหน้าผู้เข้ารับการตรวจ</Link>
      <div>
        <h1 className="text-xl font-bold text-slate-800">{header.label}</h1>
        <p className="text-sm text-slate-500">{header.code ?? "ผู้เข้าตรวจภายนอก"} · ผู้จ่าย {header.payer ?? "—"} · เพศ {header.sex === "M" ? "ชาย" : header.sex === "F" ? "หญิง" : "ไม่ระบุ"}{ageOn(dob, today) != null ? ` · อายุ ${ageOn(dob, today)} ปี` : ""}</p>
      </div>
      {open && <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"><b>แพทย์ส่งกลับให้แก้ไข ({open.by_name}):</b> {open.note}</div>}
      {approver && <UnlockPanel unlockedUntil={unlockExpiry(user)} />}
      <ReviewClient roundId={roundId} subject={params.key} tabs={tabs} sex={header.sex} age={ageOn(dob, today)} isApprover={approver} unlocked={isUnlocked(user)}
        notes={Object.fromEntries(notes.map((n) => [n.section, { summary: n.summary_text ?? "", recommendation: n.recommendation_text ?? "" }]))}
        templates={templates} conclusion={concl ? { summary: concl.summary, released: !!concl.released_at } : null}
        counts={{ required: required.length, recorded: required.filter((r) => r.result_id != null).length, verified: required.filter((r) => r.result_status === "verified" || r.result_status === "released").length, released: required.filter((r) => r.result_status === "released").length }} />
    </div>
  );
}
