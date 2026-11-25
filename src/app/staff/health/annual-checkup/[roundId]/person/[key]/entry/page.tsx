import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getSubjectClinical, getSubjectDob, getSubjectHeader, isAnnualCheckupInvalid, parseSubjectKey } from "@/lib/annual-checkup-db";
import { requireClinicalUser } from "@/lib/annual-checkup-api";
import { fileLink } from "@/lib/annual-checkup-session";
import { SECTIONS } from "@/lib/health-report/catalog";
import { ageOn } from "@/lib/health-report/interpret";
import { itemsOfTest, loadItems, valuesFromResult } from "@/lib/health-report/store";
import EntryClient, { type EntryTab } from "./EntryClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "กรอกผลตรวจตามหมวด · NOKHOOK OS PORTAL" };

// the file items (X-ray image, ECG graph) are not typed — they are attached — but the tab must still show them
const loadItemsOfTestIncludingFiles = (items: ReturnType<typeof loadItems>, testCode: string) => items.filter((i) => i.test === testCode);

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

  // One tab per section of the booklet that has at least one test this person is actually having (waived tests are left out).
  const tabs: EntryTab[] = [];
  for (const s of SECTIONS) {
    const tests = clinical.results
      .filter((r) => r.order_status !== "waived")
      .map((r) => ({ r, items: loadItemsOfTestIncludingFiles(all, r.code as string).filter((i) => i.section === s.key) }))
      .filter((x) => x.items.length > 0);
    if (!tests.length) continue;
    tabs.push({
      key: s.key, th: s.th, en: s.en,
      tests: tests.map(({ r, items }) => ({
        orderId: r.order_id as number, testCode: r.code as string, locked: r.result_status != null && r.result_status !== "draft",
        items: items.map((i) => ({ code: i.code, en: i.en, th: i.th, unit: i.unit ?? null, kind: i.kind, choices: i.choices ?? null, normal: i.normal ?? null, refs: i.refs ?? [], refText: i.refText ?? null, plausible: i.plausible ?? null, decimals: i.decimals ?? null, computed: i.computed ?? null })),
        file: r.has_file && r.result_id ? { href: fileLink(r.result_id as number, user.id) } : null,
        values: valuesFromResult(itemsOfTest(all, r.code as string), { value_num: (r.value_num as number | null) ?? null, value_text: (r.value_text as string | null) ?? null, value_json: (r.value_json as string | null) ?? null })
      }))
    });
  }
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
