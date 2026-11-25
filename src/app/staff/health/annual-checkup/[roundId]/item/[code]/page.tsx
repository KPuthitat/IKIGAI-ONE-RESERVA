import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getItemSheetRows, isAnnualCheckupInvalid } from "@/lib/annual-checkup-db";
import { requireClinicalUser } from "@/lib/annual-checkup-api";
import { SECTIONS } from "@/lib/health-report/catalog";
import { ageOn } from "@/lib/health-report/interpret";
import { enterable, itemsOfTest, loadItems, valuesFromResult } from "@/lib/health-report/store";
import ItemSheetClient from "./ItemSheetClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ลงผลรายรายการทั้งรอบ · NOKHOOK OS PORTAL" };

export default function ItemSheetPage({ params }: { params: { roundId: string; code: string } }) {
  const user = requireClinicalUser();
  const roundId = Number(params.roundId);
  if (!Number.isInteger(roundId) || roundId <= 0) notFound();
  const all = loadItems(getDb()).filter((i) => !i.hidden && !i.computed && i.kind !== "file");
  const item = all.find((i) => i.code === params.code);
  if (!item) notFound();
  const testItems = itemsOfTest(loadItems(getDb()), item.test);
  let rows: ReturnType<typeof getItemSheetRows>;
  try { rows = getItemSheetRows(user, roundId, item.test); } catch (e) { if (isAnnualCheckupInvalid(e)) notFound(); throw e; }
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const mult = Number((getDb().prepare("SELECT value FROM annual_checkup_config WHERE key = 'critical_enzyme_multiple'").get() as { value: string } | undefined)?.value ?? 5);
  const people = rows.map((r) => ({
    orderId: r.order_id, key: r.key, label: r.label, code: r.code, sex: r.sex, age: ageOn(r.dob, today), locked: r.result_status != null && r.result_status !== "draft",
    value: valuesFromResult(testItems, { value_num: r.value_num, value_text: r.value_text, value_json: r.value_json })[item.code] ?? null
  }));
  // the picker: every enterable item grouped by its booklet section
  const groups = SECTIONS.map((s) => ({ s, items: all.filter((i) => i.section === s.key && enterable([i]).length) })).filter((g) => g.items.length);
  return (
    <div className="space-y-4">
      <Link href={`/staff/health/annual-checkup/${roundId}`} className="text-sm text-slate-500 hover:text-brand">← กลับรายชื่อ</Link>
      <h1 className="text-xl font-bold text-slate-800">ลงผลรายรายการทั้งรอบ</h1>
      <ItemSheetClient roundId={roundId} current={item.code} groups={groups.map((g) => ({ key: g.s.key, th: g.s.th, items: g.items.map((i) => ({ code: i.code, label: i.en })) }))}
        item={{ code: item.code, en: item.en, th: item.th, unit: item.unit ?? null, kind: item.kind as "number" | "choice" | "text", choices: item.choices ?? null, normal: item.normal ?? null, refs: item.refs ?? [], refText: item.refText ?? null, plausible: item.plausible ?? null }}
        people={people} enzymeMultiple={Number.isFinite(mult) && mult > 0 ? mult : 5} />
    </div>
  );
}
