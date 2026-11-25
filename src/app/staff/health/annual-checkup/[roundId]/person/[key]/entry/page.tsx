import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getSubjectClinical, getSubjectDob, getSubjectHeader, isAnnualCheckupInvalid, parseSubjectKey } from "@/lib/annual-checkup-db";
import { requireClinicalUser } from "@/lib/annual-checkup-api";
import { fileLink } from "@/lib/annual-checkup-session";
import { ageOn } from "@/lib/health-report/interpret";
import { loadItems } from "@/lib/health-report/store";
import { buildTabs } from "@/lib/health-report/tabs";
import EntryClient, { type EntryTab } from "./EntryClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "กรอกผลตรวจตามหมวด · NOKHOOK OS PORTAL" };

export default function EntryPage({ params }: { params: { roundId: string; key: string } }) {
  const user = requireClinicalUser();
  const roundId = Number(params.roundId);
  const subject = parseSubjectKey(params.key);
  if (!Number.isInteger(roundId) || roundId <= 0 || !subject) notFound();
  let header: ReturnType<typeof getSubjectHeader>, clinical: ReturnType<typeof getSubjectClinical>, dob: string | null;
  try { header = getSubjectHeader(user, roundId, subject); clinical = getSubjectClinical(user, roundId, subject); dob = getSubjectDob(user, subject); }
  catch (e) { if (isAnnualCheckupInvalid(e)) notFound(); throw e; }

  const db = getDb();
  const all = loadItems(db).filter((i) => !i.hidden);
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const age = ageOn(dob, today);
  const mult = Number((db.prepare("SELECT value FROM annual_checkup_config WHERE key = 'critical_enzyme_multiple'").get() as { value: string } | undefined)?.value ?? 5);

  const tabs: EntryTab[] = buildTabs(clinical.results, all, (id) => fileLink(id, user.id));
  return (
    <div className="space-y-4">
      <Link href={`/staff/health/annual-checkup/${roundId}/person/${params.key}`} className="text-sm text-slate-500 hover:text-brand">← กลับหน้าผู้เข้ารับการตรวจ</Link>
      <div>
        <h1 className="text-xl font-bold text-slate-800">{header.label}</h1>
        <p className="text-sm text-slate-500">{header.code ?? "ผู้เข้าตรวจภายนอก (ไม่มีบัญชี)"} · เพศ {header.sex === "M" ? "ชาย" : header.sex === "F" ? "หญิง" : "ไม่ระบุ"} · อายุ {age != null ? `${age} ปี` : "ไม่ทราบ (ค่าอ้างอิงตามอายุจะใช้ไม่ได้)"}</p>
      </div>
      {tabs.length === 0
        ? <div className="card text-sm text-slate-500">คนนี้ยังไม่มีรายการตรวจที่กรอกในหน้านี้ได้</div>
        : <EntryClient tabs={tabs} sex={header.sex} age={age} enzymeMultiple={Number.isFinite(mult) && mult > 0 ? mult : 5} />}
    </div>
  );
}
