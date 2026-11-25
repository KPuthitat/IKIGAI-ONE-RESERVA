// The sections of the booklet a person is actually having, with each test's items and the values saved so far — shared by the
// entry screen and the doctor's review screen. Server only.
import { SECTIONS } from "./catalog";
import { itemsOfTest, valuesFromResult, type DbItem } from "./store";

export type TabItem = { code: string; en: string; th: string; unit: string | null; kind: "number" | "choice" | "text" | "file"; choices: string[] | null; normal: string[] | "any" | null; refs: DbItem["refs"] & object; refText: string | null; plausible: [number, number] | null; decimals: number | null; computed: "bmi" | "globulin" | "indirect_bili" | null };
export type TabTest = { orderId: number; testCode: string; locked: boolean; status: "draft" | "verified" | "released" | null; resultId: number | null; items: TabItem[]; values: Record<string, number | string | null>; file: { href: string } | null };
export type Tab = { key: string; th: string; en: string; tests: TabTest[] };

type ResultRow = Record<string, unknown>;

export function buildTabs(results: ResultRow[], all: DbItem[], fileLink: (resultId: number) => string): Tab[] {
  const tabs: Tab[] = [];
  for (const s of SECTIONS) {
    const tests = results
      .filter((r) => r.order_status !== "waived")
      .map((r) => ({ r, items: all.filter((i) => i.test === (r.code as string) && i.section === s.key) }))
      .filter((x) => x.items.length > 0);
    if (!tests.length) continue;
    tabs.push({
      key: s.key, th: s.th, en: s.en,
      tests: tests.map(({ r, items }) => ({
        orderId: r.order_id as number, testCode: r.code as string, locked: r.result_status != null && r.result_status !== "draft",
        status: (r.result_status as TabTest["status"]) ?? null, resultId: (r.result_id as number | null) ?? null,
        items: items.map((i) => ({ code: i.code, en: i.en, th: i.th, unit: i.unit ?? null, kind: i.kind, choices: i.choices ?? null, normal: i.normal ?? null, refs: i.refs ?? [], refText: i.refText ?? null, plausible: i.plausible ?? null, decimals: i.decimals ?? null, computed: i.computed ?? null })),
        file: r.has_file && r.result_id ? { href: fileLink(r.result_id as number) } : null,
        values: valuesFromResult(itemsOfTest(all, r.code as string), { value_num: (r.value_num as number | null) ?? null, value_text: (r.value_text as string | null) ?? null, value_json: (r.value_json as string | null) ?? null })
      }))
    });
  }
  return tabs;
}
