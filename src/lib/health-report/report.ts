// Builds the report a person reads (and the PDF prints) from released results: sections in the booklet's order, the three years side by
// side, high / low words, the doctor's wording, and the "what is this?" texts. Pure — no database — so the web page and the PDF
// cannot disagree. Only tests with a released result in the CURRENT round appear; nothing here knows about unreleased results.

import { SECTIONS } from "./catalog";
import { enterable, itemsOfTest, valuesFromResult, type DbItem } from "./store";
import { ageOn, bmi, bmiCategory, FLAG_TH, flagResult, globulin, HEARING_FREQS, indirectBilirubin, interpretHearing, interpretSpirometry, refLabel, type Flag } from "./interpret";
import type { ReportData, ReportResultRow } from "../annual-checkup-db";

export type RCell = { year: number; text: string; flag: Flag | null };
export type RRow = { code: string; en: string; th: string; unit: string; ref: string; cells: RCell[]; flagWord: string; explain: string | null };
export type RSection = {
  key: string; th: string; en: string; rows: RRow[]; lines: string[];
  note: { summary: string; recommendation: string } | null; file: { resultId: number } | null; intro: { title: string; body: string } | null; edu: { title: string; body: string } | null;
};
export type Report = {
  roundName: string; years: number[]; currentYear: number | null;
  header: { examDate: string | null; name: string; age: number | null; sex: "M" | "F" | null; company: string | null; employeeCode: string | null; position: string | null; department: string | null };
  summary: { abnormal: Array<{ section: string; name: string; value: string; word: string }>; recommendations: string[]; overall: { summary: string; recommendation: string; verdict: string | null } };
  sections: RSection[];
};

type Texts = Record<string, { title: string | null; body: string }>;
const EDU_BY_SECTION: Record<string, string> = { audio: "EDU_audio", vision: "EDU_vision", pft: "EDU_pft", cxr: "EDU_cxr", ecg: "EDU_ecg" };

function numText(v: number | string | null | undefined, it: DbItem): string {
  if (v == null || v === "") return "-";
  if (typeof v === "number") return it.decimals != null ? v.toFixed(it.decimals) : String(v);
  return String(v);
}

type PerYear = Map<number, Map<string, number | string | null>>;    // year → item code → value

function collect(items: DbItem[], rows: ReportResultRow[]): Map<string, number | string | null> {
  const out = new Map<string, number | string | null>();
  for (const r of rows) for (const [k, v] of Object.entries(valuesFromResult(itemsOfTest(items, r.code), r))) out.set(k, v);
  return out;
}

export function buildReport(d: ReportData, allItems: DbItem[], texts: Texts, today: string): Report {
  const items = allItems.filter((i) => !i.hidden);
  const cur = d.round.year_be;
  const years = cur != null ? [cur - 2, cur - 1, cur] : [];
  const perYear: PerYear = new Map();
  if (cur != null) {
    perYear.set(cur, collect(items, d.results));
    for (const [y, rows] of Object.entries(d.history)) perYear.set(Number(y), collect(items, rows));
  }
  const currentVals = collect(items, d.results);
  const releasedTests = new Set(d.results.map((r) => r.code));
  const age = ageOn(d.person.dob, d.round.exam_date ?? today);
  const sex = d.person.sex;
  const note = (k: string) => d.notes.find((n) => n.section === k);
  const abnormal: Report["summary"]["abnormal"] = [];

  const valueAt = (y: number, it: DbItem): number | string | null => {
    const m = perYear.get(y);
    if (!m) return null;
    if (it.computed === "bmi") return bmi(num(m.get("WEIGHT")), num(m.get("HEIGHT")));
    if (it.computed === "globulin") return num(m.get("TP")) != null && num(m.get("ALB")) != null ? globulin(num(m.get("TP"))!, num(m.get("ALB"))!) : null;
    if (it.computed === "indirect_bili") return num(m.get("TBIL")) != null && num(m.get("DBIL")) != null ? indirectBilirubin(num(m.get("TBIL"))!, num(m.get("DBIL"))!) : null;
    return m.get(it.code) ?? null;
  };
  function num(v: number | string | null | undefined): number | null { return typeof v === "number" ? v : null; }

  const sections: RSection[] = [];
  for (const s of SECTIONS) {
    const secItems = items.filter((i) => i.section === s.key && i.kind !== "file" && releasedTests.has(i.test));
    const fileItem = items.find((i) => i.section === s.key && i.kind === "file" && releasedTests.has(i.test));
    if (secItems.length === 0 && !fileItem) continue;
    const rows: RRow[] = [];
    const lines: string[] = [];
    const cellsFor = (it: DbItem): RCell[] => years.map((y) => {
      const v = valueAt(y, it);
      return { year: y, text: numText(v, it), flag: v == null ? null : flagResult(it, v, sex, y === cur ? age : age != null && cur != null ? age - (cur - y) : null) };
    });
    if (s.key === "audio") {
      for (const f of HEARING_FREQS) {
        const r = items.find((i) => i.code === `AUD_R_${f}`)!, l = items.find((i) => i.code === `AUD_L_${f}`)!;
        const cells: RCell[] = years.map((y) => {
          const rv = valueAt(y, r), lv = valueAt(y, l);
          const worst: Flag | null = rv == null && lv == null ? null : [flagResult(r, rv, sex, age), flagResult(l, lv, sex, age)].includes("high") ? "high" : "normal";
          return { year: y, text: `${rv ?? "-"} / ${lv ?? "-"}`, flag: worst };
        });
        rows.push({ code: `AUD_${f}`, en: `Frequency ${f.toLocaleString("en-US")} Hertz (Hz)`, th: `ระดับการได้ยิน - ความถี่ ${f.toLocaleString("en-US")} เฮิรตซ์ (ขวา / ซ้าย)`, unit: "dB", ref: "≤ 25 dB", cells, flagWord: cells[cells.length - 1]?.flag === "high" ? "ลดลง" : "", explain: null });
      }
      const ear = (e: "R" | "L") => Object.fromEntries(HEARING_FREQS.map((f) => [f, num(currentVals.get(`AUD_${e}_${f}`))]));
      const h = interpretHearing(ear("R"), ear("L"));
      if (h) lines.push(h);
    } else {
      for (const it of secItems) {
        const cells = cellsFor(it);
        const c = cells[cells.length - 1];
        const word = c?.flag && c.flag !== "normal" && c.flag !== "info" ? FLAG_TH[c.flag] : "";
        if (cur != null && c && c.text !== "-" && word) abnormal.push({ section: s.th, name: it.en, value: `${c.text}${it.unit ? ` ${it.unit}` : ""}`, word });
        rows.push({ code: it.code, en: it.en, th: it.th, unit: it.unit ?? "", ref: it.computed === "bmi" ? "" : refLabel(it), cells: cur != null ? cells : [{ year: 0, text: numText(currentVals.get(it.code) ?? null, it), flag: null }], flagWord: word, explain: texts[it.code]?.body ?? null });
      }
    }
    if (s.key === "audio" && lines[0] && /ลดลง/.test(lines[0])) abnormal.push({ section: s.th, name: "Audiometry", value: lines[0].replace(/การได้ยินของหู(ขวา|ซ้าย)ปกติ( \/ )?/g, "").replace(/ \/ $/, ""), word: "ลดลง" });
    if (s.key === "general") {
      const b = bmi(num(currentVals.get("WEIGHT")), num(currentVals.get("HEIGHT")));
      if (b != null) lines.push(`ดัชนีมวลกาย ${b.toFixed(1)} กก./ตร.ม. — ${bmiCategory(b)}`);
    }
    if (s.key === "pft") {
      const sp = interpretSpirometry({ age, fvcPct: num(currentVals.get("FVC_PCT")), fev1Pct: num(currentVals.get("FEV1_PCT")), ratio: num(currentVals.get("FEV1FVC_MEAS")) });
      if (sp.kind !== "incomplete") lines.push(sp.th);
      if (sp.kind !== "normal" && sp.kind !== "incomplete") abnormal.push({ section: s.th, name: "Pulmonary function", value: sp.th, word: "ผิดปกติ" });
    }
    const n = note(s.key);
    sections.push({
      key: s.key, th: s.th, en: s.en, rows, lines,
      note: n && (n.summary_text || n.recommendation_text) ? { summary: n.summary_text ?? "", recommendation: n.recommendation_text ?? "" } : null,
      file: fileItem ? (() => { const r = d.results.find((x) => x.code === fileItem.test && x.has_file); return r ? { resultId: r.result_id } : null; })() : null,
      intro: texts[s.key] ? { title: texts[s.key].title ?? s.th, body: texts[s.key].body } : null,
      edu: EDU_BY_SECTION[s.key] && texts[EDU_BY_SECTION[s.key]] ? { title: texts[EDU_BY_SECTION[s.key]].title ?? "", body: texts[EDU_BY_SECTION[s.key]].body } : null
    });
  }

  const overall = note("overall");
  const recs: string[] = [];
  if (overall?.recommendation_text) recs.push(overall.recommendation_text);
  else if (d.conclusion?.doctor_comment) recs.push(d.conclusion.doctor_comment);
  for (const n of d.notes) if (n.section !== "overall" && n.recommendation_text) recs.push(n.recommendation_text);
  const verdict = d.conclusion?.summary ? ({ normal: "ปกติ", abnormal: "ผิดปกติ", follow_up: "ต้องติดตาม" } as Record<string, string>)[d.conclusion.summary] ?? null : null;
  return {
    roundName: d.round.name, years, currentYear: cur,
    header: { examDate: d.round.exam_date, name: d.person.label, age, sex, company: d.person.company, employeeCode: d.person.employee_code, position: d.person.position, department: d.person.department },
    summary: { abnormal, recommendations: recs, overall: { summary: overall?.summary_text ?? "", recommendation: overall?.recommendation_text ?? d.conclusion?.doctor_comment ?? "", verdict } },
    sections
  };
}
void enterable;
