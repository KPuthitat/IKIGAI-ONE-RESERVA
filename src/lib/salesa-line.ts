// SALESA — LINE Flex cards for the HOD group (owner 2026-09-16). A daily sales
// summary (pushed every day the file is imported) and a weekly summary (Mon–Sun,
// pushed the following Monday). Mirrors the revshare card style; pushed to the
// branch's configured HOD group via the platform OA.

import { sendLinePush } from "./line";
import { getPlatformChannel } from "./messaging-channels";
import type { DailyAnalytics, WeeklyAnalytics, MonthlyAnalytics, CompanyOverview } from "./salesa-analytics";
import type { SalesPushPlan } from "./salesa-push";
import type { ClinicaMonth, ClinicaWeek, ClinicaDailyReport } from "./clinica-analytics";
import type { BranchForecast } from "./forecast";
import { clinicaPaidPct } from "./clinica-shared";

type FlexMsg = { type: "flex"; altText: string; contents: unknown };

const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท";
const intTh = (n: number) => n.toLocaleString("th-TH");

function kv(label: string, value: string, opts?: { color?: string; bold?: boolean; size?: string }): unknown {
  return {
    type: "box", layout: "horizontal", contents: [
      { type: "text", text: label, size: opts?.size ?? "sm", color: "#666666", flex: 5, wrap: true },
      { type: "text", text: value, size: opts?.size ?? "sm", color: opts?.color ?? "#1a1a2e", weight: opts?.bold ? "bold" : "regular", align: "end", flex: 4, wrap: true }
    ]
  };
}
const sep = { type: "separator", margin: "md", color: "#eeeeee" };

// Per-branch header colour (owner 2026-09-17) — passed via meta.color; white
// tints on the eyebrow/subtitle keep it legible on any dark brand colour.
function header(title: string, subtitle: string, color: string, eyebrow = "IKIGAI OS · ยอดขายรายวัน"): unknown {
  return {
    type: "box", layout: "vertical", backgroundColor: color, paddingAll: "16px", spacing: "xs",
    contents: [
      { type: "text", text: eyebrow, size: "xxs", color: "#ffffff99" },
      { type: "text", text: title, size: "lg", weight: "bold", color: "#ffffff" },
      { type: "text", text: subtitle, size: "xs", color: "#ffffffcc", wrap: true }
    ]
  };
}
function footer(note: string): unknown {
  return {
    type: "box", layout: "vertical", paddingAll: "10px",
    contents: [{ type: "text", text: note, size: "xxs", color: "#aaaaaa", wrap: true, align: "center" }]
  };
}

/** A ranked menu list (name → revenue). */
function menuBlock(title: string, list: Array<{ name: string; nett: number }>): unknown[] {
  if (!list.length) return [];
  return [
    { type: "text", text: title, size: "xs", weight: "bold", color: "#0e2724", margin: "md" },
    ...list.map((m, i) => ({
      type: "box", layout: "horizontal", contents: [
        { type: "text", text: `${i + 1}. ${m.name}`, size: "xs", color: "#333333", flex: 6, wrap: true },
        { type: "text", text: baht(m.nett), size: "xs", color: "#1a1a2e", align: "end", flex: 3 }
      ]
    }))
  ];
}

export type DailyCardMeta = { branchName: string; operator: string; color: string };

/** Auto summary + short recommendations block (owner 2026-09-18). Rendered as a
 *  soft-tinted callout near the top so executives read the takeaways first. */
function adviceBlock(advice: string[], color: string): unknown[] {
  if (!advice.length) return [];
  return [{
    type: "box", layout: "vertical", backgroundColor: "#f4f7f6", cornerRadius: "md", paddingAll: "12px", spacing: "sm", margin: "sm",
    contents: [
      { type: "text", text: "สรุป & คำแนะนำ", size: "xs", weight: "bold", color },
      ...advice.map((line) => ({
        type: "box", layout: "horizontal", spacing: "sm", contents: [
          { type: "text", text: "•", size: "sm", color, flex: 0 },
          { type: "text", text: line, size: "xs", color: "#333333", wrap: true, flex: 1 }
        ]
      }))
    ]
  }];
}

// A metric's value + a two-part comparison line — same weekday last week ·
// same day last month — each % coloured green/red via spans (owner 2026-09-17).
function pctSpan(p: number | null) {
  if (p == null) return { type: "span", text: "—", color: "#bbbbbb" };
  const up = p >= 0;
  return { type: "span", text: `${up ? "▲" : "▼"} ${Math.abs(p).toFixed(1)}%`, color: up ? "#0f7a4f" : "#b0392f" };
}
function metricCompareLine(m: { wowPct: number | null; momPct: number | null }, wowLabel: string, momLabel: string): unknown {
  if (m.wowPct == null && m.momPct == null) {
    return { type: "text", text: "ยังไม่มีข้อมูลเทียบ", size: "xxs", color: "#bbbbbb", wrap: true };
  }
  return {
    type: "text", size: "xxs", wrap: true, contents: [
      { type: "span", text: `${wowLabel} `, color: "#999999" }, pctSpan(m.wowPct),
      { type: "span", text: `   ${momLabel} `, color: "#999999" }, pctSpan(m.momPct)
    ]
  };
}

// Team-tagged event notes on a report card (owner 2026-09-27: "ให้โน้ตย้อนหลังไป
// โผล่ในรายงานรายวัน/สัปดาห์ด้วย"). Capped so a heavily-tagged period can't push the
// flex message past LINE's size limit.
function eventNotesBlock(notes: string[]): unknown[] {
  if (!notes.length) return [];
  const shown = notes.slice(0, 6);
  return [
    sep,
    { type: "text", text: "โน้ตเหตุการณ์จากทีม", size: "xs", weight: "bold", color: "#7c3aed", margin: "md" },
    ...shown.map((n) => ({ type: "text", text: `📌 ${n}`, size: "xxs", color: "#7c3aed", wrap: true })),
    ...(notes.length > shown.length ? [{ type: "text", text: `📌 +${notes.length - shown.length} เพิ่มเติม`, size: "xxs", color: "#7c3aed", wrap: true }] : []),
  ];
}
function eventNotesWeekBlock(days: Array<{ dateLabel: string; notes: string[] }>): unknown[] {
  const items: Array<{ label: string; note: string }> = [];
  for (const d of days) for (const n of d.notes) items.push({ label: d.dateLabel, note: n });
  if (!items.length) return [];
  const shown = items.slice(0, 12);
  const out: unknown[] = [sep, { type: "text", text: "โน้ตเหตุการณ์จากทีม", size: "xs", weight: "bold", color: "#7c3aed", margin: "md" }];
  let lastLabel = "";
  for (const it of shown) {
    if (it.label !== lastLabel) { out.push({ type: "text", text: it.label, size: "xxs", weight: "bold", color: "#7c3aed", wrap: true }); lastLabel = it.label; }
    out.push({ type: "text", text: `📌 ${it.note}`, size: "xxs", color: "#7c3aed", wrap: true });
  }
  if (items.length > shown.length) out.push({ type: "text", text: `📌 +${items.length - shown.length} เพิ่มเติม`, size: "xxs", color: "#7c3aed", wrap: true });
  return out;
}

export function salesaDailyFlex(a: DailyAnalytics, meta: DailyCardMeta): FlexMsg {
  const r = a.row;
  const body: unknown[] = [
    { type: "text", text: meta.branchName, weight: "bold", size: "lg", wrap: true },
    { type: "text", text: `บันทึกโดย: ${meta.operator}`, size: "xxs", color: "#999999", wrap: true },
    ...adviceBlock(a.advice, meta.color),
    sep
  ];
  // Every headline metric with its own comparison % (owner 2026-09-17).
  a.metrics.forEach((m) => {
    const value = m.kind === "baht" ? baht(m.value)
      : m.key === "bills" ? `${intTh(m.value)} บิล`
      : m.key === "pax" ? `${intTh(m.value)} คน`
      : intTh(m.value);
    const isNett = m.key === "nett";
    body.push(kv(m.label, value, isNett ? { bold: true, color: "#0f7a4f", size: "md" } : { size: "xs" }));
    body.push(metricCompareLine(m, a.wowLabel, a.momLabel));
  });
  body.push(kv("ส่วนลด", `${baht(Math.abs(r.discount))}${a.discountPct != null ? ` (${a.discountPct.toFixed(1)}%)` : ""}`, { size: "xs", color: "#b0392f" }));
  if (r.void_amount > 0) body.push(kv("ยกเลิกบิล (Void)", `${baht(r.void_amount)} · ${intTh(r.void_bill_count)} บิล`, { size: "xs", color: "#b0392f" }));
  if (r.refund > 0) body.push(kv("คืนเงิน (Refund)", baht(r.refund), { size: "xs", color: "#b0392f" }));

  if (r.payments.length) {
    body.push(sep);
    body.push({ type: "text", text: "ช่องทางชำระเงิน", size: "xs", weight: "bold", color: "#0e2724" });
    r.payments.forEach((p) => body.push(kv(`${p.name} · ${intTh(p.qty)} บิล`, baht(p.total), { size: "xs" })));
  }
  if (r.types.length) {
    const active = r.types.filter((t) => t.sales > 0 || t.qty > 0);
    if (active.length) {
      body.push({ type: "text", text: "ประเภทออเดอร์", size: "xs", weight: "bold", color: "#0e2724", margin: "sm" });
      active.forEach((t) => body.push(kv(`${t.name} · ${intTh(t.qty)}`, baht(t.sales), { size: "xs" })));
    }
  }

  if (a.topItems.length || a.topCategories.length) body.push(sep);
  body.push(...menuBlock("เมนูทำรายได้สูงสุด", a.topItems));
  body.push(...menuBlock("หมวดทำรายได้สูงสุด", a.topCategories));
  if (a.bottomItems.length) body.push(...menuBlock("เมนูทำรายได้น้อยสุด (ในรายการที่มี)", a.bottomItems));
  body.push(...eventNotesBlock(a.eventNotes));

  return {
    type: "flex",
    altText: `สรุปยอดขายประจำวัน ${a.dateLabel} · ${meta.branchName} · ${baht(r.nett)}`,
    contents: {
      type: "bubble", size: "giga",
      header: header("สรุปยอดขายประจำวัน", `${a.dateLabel} · ${meta.branchName}`, meta.color),
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer: footer("สรุปโดยระบบ IKIGAI OS · ยอดสะสมสรุปอีกครั้งในรอบสัปดาห์")
    }
  };
}

export function salesaWeeklyFlex(w: WeeklyAnalytics, meta: DailyCardMeta): FlexMsg {
  const body: unknown[] = [
    { type: "text", text: meta.branchName, weight: "bold", size: "lg", wrap: true },
    { type: "text", text: `สรุปโดย: ${meta.operator} · รวม ${w.dayCount} วัน`, size: "xxs", color: "#999999", wrap: true },
    sep,
    kv("ยอดขายรวมสัปดาห์", baht(w.totalNett), { bold: true, color: "#0f7a4f", size: "md" }),
    // Week-over-week comparison (owner 2026-09-17).
    (w.wowNettPct == null
      ? { type: "text", text: "เทียบสัปดาห์ก่อน: ยังไม่มีข้อมูลเทียบ", size: "xxs", color: "#bbbbbb", wrap: true }
      : { type: "text", size: "xxs", wrap: true, contents: [
          { type: "span", text: "เทียบสัปดาห์ก่อน ", color: "#999999" }, pctSpan(w.wowNettPct),
          { type: "span", text: `  (${baht(w.prevWeekNett ?? 0)})`, color: "#bbbbbb" }
        ] }),
    kv("จำนวนบิลรวม", `${intTh(w.totalBills)} บิล`, { size: "xs" }),
    ...(w.wowBillsPct != null ? [{ type: "text", size: "xxs", wrap: true, contents: [{ type: "span", text: "เทียบสัปดาห์ก่อน ", color: "#999999" }, pctSpan(w.wowBillsPct)] }] : []),
    kv("ลูกค้ารวม", `${intTh(w.totalPax)} คน`, { size: "xs" }),
    ...(w.wowPaxPct != null ? [{ type: "text", size: "xxs", wrap: true, contents: [{ type: "span", text: "เทียบสัปดาห์ก่อน ", color: "#999999" }, pctSpan(w.wowPaxPct)] }] : []),
    ...(w.avgPerDay != null ? [kv("เฉลี่ยต่อวัน", baht(w.avgPerDay), { size: "xs" })] : []),
    ...(w.avgPerBill != null ? [kv("เฉลี่ยต่อบิล", baht(w.avgPerBill), { size: "xs" })] : []),
    kv("ส่วนลดรวม", baht(Math.abs(w.totalDiscount)), { size: "xs", color: "#b0392f" }),
    ...(w.bestDate ? [kv("วันขายดีสุด", `${w.days.find((d) => d.date === w.bestDate)?.dateLabel ?? w.bestDate} · ${baht(w.bestNett ?? 0)}`, { size: "xs" })] : [])
  ];

  if (w.days.length) {
    body.push(sep);
    body.push({ type: "text", text: "ยอดขายรายวัน", size: "xs", weight: "bold", color: "#0e2724" });
    w.days.forEach((d) => body.push(kv(d.dateLabel, `${baht(d.nett)} · ${intTh(d.billCount)} บิล`, { size: "xs" })));
  }

  if (w.topItems.length || w.topCategories.length) body.push(sep);
  body.push(...menuBlock("เมนูทำรายได้สูงสุดประจำสัปดาห์", w.topItems));
  body.push(...menuBlock("หมวดทำรายได้สูงสุดประจำสัปดาห์", w.topCategories));

  // Menu momentum vs last week (owner B).
  const momoLine = (m: { name: string; deltaPct: number | null }, up: boolean) => ({
    type: "box", layout: "horizontal", contents: [
      { type: "text", text: m.name, size: "xs", color: "#333333", flex: 6, wrap: true },
      { type: "text", text: m.deltaPct == null ? "ใหม่" : `${m.deltaPct >= 0 ? "▲" : "▼"} ${Math.abs(m.deltaPct).toFixed(0)}%`, size: "xs", align: "end", flex: 2, color: up ? "#0f7a4f" : "#b0392f" }
    ]
  });
  if (w.menuRisers.length) {
    body.push({ type: "text", text: "เมนูมาแรง (เทียบสัปดาห์ก่อน)", size: "xs", weight: "bold", color: "#0f7a4f", margin: "md" });
    w.menuRisers.forEach((m) => body.push(momoLine(m, true)));
  }
  if (w.menuFallers.length) {
    body.push({ type: "text", text: "เมนูร่วง (เทียบสัปดาห์ก่อน)", size: "xs", weight: "bold", color: "#b0392f", margin: "md" });
    w.menuFallers.forEach((m) => body.push(momoLine(m, false)));
  }
  body.push(...eventNotesWeekBlock(w.eventNotes));

  return {
    type: "flex",
    altText: `สรุปยอดขายประจำสัปดาห์ ${w.label} · ${meta.branchName} · ${baht(w.totalNett)}`,
    contents: {
      type: "bubble", size: "giga",
      header: header("สรุปยอดขายประจำสัปดาห์", `${w.label} · ${meta.branchName}`, meta.color),
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer: footer("สรุปโดยระบบ IKIGAI OS · รอบจันทร์–อาทิตย์")
    }
  };
}

// ── F · monthly summary card (sent on the 1st for the previous month) ───────
export function salesaMonthlyFlex(m: MonthlyAnalytics, meta: DailyCardMeta): FlexMsg {
  const yoy = (label: string, base: number | null, pctVal: number | null): unknown =>
    base == null
      ? { type: "text", text: `${label}: ยังไม่มีข้อมูลเทียบ`, size: "xxs", color: "#bbbbbb", wrap: true }
      : { type: "text", size: "xxs", wrap: true, contents: [{ type: "span", text: `${label} `, color: "#999999" }, pctSpan(pctVal), { type: "span", text: `  (${baht(base)})`, color: "#bbbbbb" }] };

  const body: unknown[] = [
    { type: "text", text: meta.branchName, weight: "bold", size: "lg", wrap: true },
    { type: "text", text: `สรุปโดย: ${meta.operator} · รวม ${m.dayCount} วัน`, size: "xxs", color: "#999999", wrap: true },
    sep,
    kv("ยอดขายรวมทั้งเดือน", baht(m.totalNett), { bold: true, color: "#0f7a4f", size: "md" }),
    ...(m.revshareIncome > 0 ? [{ type: "text", text: `รวมส่วนแบ่งยอดขายรายเดือน ${baht(m.revshareIncome)} (นอก POS)`, size: "xxs", color: "#7c3aed", wrap: true }] : []),
    yoy("เทียบเดือนก่อน (ช่วงเดียวกัน)", m.prevMonthNett, m.prevMonthPct),
    yoy("เทียบปีก่อน (ช่วงเดียวกัน)", m.lastYearNett, m.lastYearPct),
    kv("จำนวนบิลรวม", `${intTh(m.totalBills)} บิล`, { size: "xs" }),
    kv("ลูกค้ารวม", `${intTh(m.totalPax)} คน`, { size: "xs" }),
    ...(m.avgPerDay != null ? [kv("เฉลี่ยต่อวัน", baht(m.avgPerDay), { size: "xs" })] : []),
    ...(m.avgPerBill != null ? [kv("เฉลี่ยต่อบิล", baht(m.avgPerBill), { size: "xs" })] : []),
    kv("ส่วนลดรวม", baht(Math.abs(m.totalDiscount)), { size: "xs", color: "#b0392f" }),
    ...(m.bestDate ? [kv("วันขายดีสุด", `${m.bestDate} · ${baht(m.bestNett ?? 0)}`, { size: "xs" })] : [])
  ];
  if (m.topItems.length || m.topCategories.length) body.push(sep);
  body.push(...menuBlock("เมนูทำรายได้สูงสุดประจำเดือน", m.topItems));
  body.push(...menuBlock("หมวดทำรายได้สูงสุดประจำเดือน", m.topCategories));

  return {
    type: "flex",
    altText: `สรุปยอดขายประจำเดือน ${m.label} · ${meta.branchName} · ${baht(m.totalNett)}`,
    contents: {
      type: "bubble", size: "giga",
      header: header("สรุปยอดขายประจำเดือน", `${m.label} · ${meta.branchName}`, meta.color),
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer: footer("สรุปโดยระบบ IKIGAI OS · รอบรายเดือน")
    }
  };
}

// ── CLINICA monthly summary (owner 2026-09-26: ส่งรายงานคลินิกให้ผู้บริหารเหมือน
//    ร้านอาหาร) ────────────────────────────────────────────────────────────────
export function clinicaMonthlyFlex(c: ClinicaMonth, meta: DailyCardMeta, monthLabel: string): FlexMsg {
  const paidPct = clinicaPaidPct(c);
  const momLine: unknown = c.billNetMomPct == null
    ? { type: "text", text: "เทียบเดือนก่อน: ยังไม่มีข้อมูล", size: "xxs", color: "#bbbbbb", wrap: true }
    : { type: "text", size: "xxs", wrap: true, contents: [{ type: "span", text: "เทียบเดือนก่อน ", color: "#999999" }, pctSpan(c.billNetMomPct), ...(c.prevBillNet != null ? [{ type: "span", text: `  (${baht(c.prevBillNet)})`, color: "#bbbbbb" }] : [])] };
  // เทียบปีก่อน (owner 2026-09-27) — omit the line entirely when there's no year-ago data.
  const yoyLine: unknown = c.lastYearBillNet == null ? null
    : { type: "text", size: "xxs", wrap: true, contents: [{ type: "span", text: "เทียบปีก่อน ", color: "#999999" }, pctSpan(c.billNetYoyPct), { type: "span", text: `  (${baht(c.lastYearBillNet)})`, color: "#bbbbbb" }] };

  const body: unknown[] = [
    { type: "text", text: meta.branchName, weight: "bold", size: "lg", wrap: true },
    { type: "text", text: `สรุปโดย: ${meta.operator}`, size: "xxs", color: "#999999", wrap: true },
    ...adviceBlock(c.advice, meta.color),
    sep,
    kv("ยอดบิลรวม", `${baht(c.billNet)} (${intTh(c.billCount)} ครั้ง)`, { bold: true, color: "#0f7a4f", size: "md" }),
    momLine,
    ...(yoyLine ? [yoyLine] : []),
    kv("เงินเข้าจริง (เงินสด/พร้อมเพย์)", `${baht(c.paid)} (${paidPct}%)`, { size: "xs", color: "#0f7a4f" }),
    kv("รอเบิก (บิลเดือนนี้)", `${baht(c.due)} (${100 - paidPct}%)`, { size: "xs", color: "#b0392f" }),
    kv("คนไข้ (บิล)", `${intTh(c.patientCount)} คน`, { size: "xs" }),
    ...(c.newPatients + c.returningPatients > 0 ? [kv("คนไข้ใหม่ · กลับมาซ้ำ", `${intTh(c.newPatients)} · ${intTh(c.returningPatients)} คน`, { size: "xs" })] : []),
    ...(c.avgPerBill != null ? [kv("เฉลี่ยต่อบิล", baht(c.avgPerBill), { size: "xs" })] : []),
    ...(c.target ? [kv("เป้าเดือนนี้", `${baht(c.target.target)} · ${c.target.pct.toFixed(0)}%`, { size: "xs", color: c.target.pct >= 100 ? "#0f7a4f" : "#b8860b" })] : []),
  ];
  if (c.arTotal > 0.5) {
    body.push(sep);
    body.push(kv("รอเบิกค้างสะสม (ทุกงวด)", baht(c.arTotal), { size: "xs", bold: true, color: "#b0392f" }));
    if (c.arAging.d90p > 0.5) body.push(kv("• เกิน 90 วัน", baht(c.arAging.d90p), { size: "xxs", color: "#b0392f" }));
  }
  if (c.categories.length) {
    body.push(sep);
    body.push({ type: "text", text: "โครงสร้างรายได้", size: "xs", weight: "bold", color: "#0e2724", margin: "md" });
    for (const cat of c.categories.slice(0, 4)) {
      body.push({ type: "box", layout: "horizontal", contents: [
        { type: "text", text: cat.label, size: "xs", color: "#333333", flex: 6, wrap: true },
        { type: "text", text: `${baht(cat.net)} (${intTh(cat.count)})`, size: "xs", color: "#1a1a2e", align: "end", flex: 4 }
      ] });
    }
  }

  return {
    type: "flex",
    altText: `สรุปคลินิกประจำเดือน ${monthLabel} · ${meta.branchName} · ${baht(c.billNet)}`,
    contents: {
      type: "bubble", size: "giga",
      header: header("สรุปคลินิกประจำเดือน", `${monthLabel} · ${meta.branchName}`, meta.color, "IKIGAI OS · รายงานคลินิก"),
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer: footer("สรุปโดยระบบ IKIGAI OS · รอบรายเดือน (คลินิก)")
    }
  };
}

/** Clinic daily exec card (owner 2026-09-27) — one day vs the same weekday last week. */
export function clinicaDailyFlex(c: ClinicaDailyReport, meta: DailyCardMeta): FlexMsg {
  const paidPct = c.billNet > 0 ? Math.round((c.paid / c.billNet) * 100) : 0;
  const wowLine: unknown = c.prevSameDowNet == null ? null
    : { type: "text", size: "xxs", wrap: true, contents: [{ type: "span", text: `เทียบ${c.wowLabel} `, color: "#999999" }, pctSpan(c.wowPct), { type: "span", text: `  (${baht(c.prevSameDowNet)})`, color: "#bbbbbb" }] };
  const body: unknown[] = [
    { type: "text", text: meta.branchName, weight: "bold", size: "lg", wrap: true },
    { type: "text", text: `สรุปโดย: ${meta.operator}`, size: "xxs", color: "#999999", wrap: true },
    sep,
    kv("ยอดบิลวันนี้", `${baht(c.billNet)} (${intTh(c.billCount)} ครั้ง)`, { bold: true, color: "#0f7a4f", size: "md" }),
    ...(wowLine ? [wowLine] : []),
    kv("เงินเข้าจริง (เงินสด/พร้อมเพย์)", `${baht(c.paid)} (${paidPct}%)`, { size: "xs", color: "#0f7a4f" }),
    kv("รอเบิก", baht(c.due), { size: "xs", color: "#b0392f" }),
    kv("คนไข้", `${intTh(c.patientCount)} คน`, { size: "xs" }),
    ...(c.avgPerBill != null ? [kv("เฉลี่ยต่อบิล", baht(c.avgPerBill), { size: "xs" })] : []),
  ];
  if (c.categories.length) {
    body.push(sep, { type: "text", text: "โครงสร้างรายได้", size: "xs", weight: "bold", color: "#0e2724", margin: "md" });
    for (const cat of c.categories.slice(0, 4)) body.push({ type: "box", layout: "horizontal", contents: [
      { type: "text", text: cat.label, size: "xs", color: "#333333", flex: 6, wrap: true },
      { type: "text", text: `${baht(cat.net)} (${intTh(cat.count)})`, size: "xs", color: "#1a1a2e", align: "end", flex: 4 }] });
  }
  if (c.topItems.length) {
    body.push(sep, { type: "text", text: "รายการทำเงินสูงสุด", size: "xs", weight: "bold", color: "#0e2724", margin: "md" });
    for (const it of c.topItems.slice(0, 4)) body.push({ type: "box", layout: "horizontal", contents: [
      { type: "text", text: it.name, size: "xs", color: "#333333", flex: 6, wrap: true },
      { type: "text", text: `${baht(it.net)} (${intTh(it.qty)})`, size: "xs", color: "#1a1a2e", align: "end", flex: 4 }] });
  }
  body.push(...eventNotesBlock(c.eventNotes));
  return {
    type: "flex", altText: `สรุปคลินิกรายวัน ${c.dateLabel} · ${meta.branchName} · ${baht(c.billNet)}`,
    contents: { type: "bubble", size: "giga",
      header: header("สรุปคลินิกรายวัน", `${c.dateLabel} · ${meta.branchName}`, meta.color, "IKIGAI OS · รายงานคลินิก"),
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer: footer("สรุปโดยระบบ IKIGAI OS · รอบรายวัน (คลินิก)") }
  };
}

/** Clinic weekly exec card (owner 2026-09-27) — Mon–Sun vs the previous week. */
export function clinicaWeeklyFlex(c: ClinicaWeek, meta: DailyCardMeta): FlexMsg {
  const wowLine: unknown = c.prevWeekNet == null
    ? { type: "text", text: "เทียบสัปดาห์ก่อน: ยังไม่มีข้อมูล", size: "xxs", color: "#bbbbbb", wrap: true }
    : { type: "text", size: "xxs", wrap: true, contents: [{ type: "span", text: "เทียบสัปดาห์ก่อน ", color: "#999999" }, pctSpan(c.wowNetPct), { type: "span", text: `  (${baht(c.prevWeekNet)})`, color: "#bbbbbb" }] };
  const body: unknown[] = [
    { type: "text", text: meta.branchName, weight: "bold", size: "lg", wrap: true },
    { type: "text", text: `สรุปโดย: ${meta.operator}`, size: "xxs", color: "#999999", wrap: true },
    sep,
    kv("ยอดบิลรวมสัปดาห์", `${baht(c.totalNet)} (${intTh(c.totalBills)} ครั้ง)`, { bold: true, color: "#0f7a4f", size: "md" }),
    wowLine,
    kv("คนไข้รวม", `${intTh(c.totalPatients)} คน`, { size: "xs" }),
    ...(c.avgPerDay != null ? [kv("เฉลี่ยต่อวัน", baht(c.avgPerDay), { size: "xs" })] : []),
  ];
  if (c.topItems.length) {
    body.push(sep, { type: "text", text: "รายการทำเงินสูงสุดประจำสัปดาห์", size: "xs", weight: "bold", color: "#0e2724", margin: "md" });
    for (const it of c.topItems.slice(0, 5)) body.push({ type: "box", layout: "horizontal", contents: [
      { type: "text", text: it.name, size: "xs", color: "#333333", flex: 6, wrap: true },
      { type: "text", text: `${baht(it.net)} (${intTh(it.qty)})`, size: "xs", color: "#1a1a2e", align: "end", flex: 4 }] });
  }
  body.push(...eventNotesWeekBlock(c.eventNotes));
  return {
    type: "flex", altText: `สรุปคลินิกรายสัปดาห์ ${c.label} · ${meta.branchName} · ${baht(c.totalNet)}`,
    contents: { type: "bubble", size: "giga",
      header: header("สรุปคลินิกรายสัปดาห์", `${c.label} · ${meta.branchName}`, meta.color, "IKIGAI OS · รายงานคลินิก"),
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer: footer("สรุปโดยระบบ IKIGAI OS · รอบรายสัปดาห์ (คลินิก)") }
  };
}

/** Forward plan card (owner 2026-09-27) — next few days' predicted sales +
 *  holidays/weather + a น้องฮูก suggestion each, for the branch team. */
export function salesaForecastFlex(fc: BranchForecast, meta: DailyCardMeta): FlexMsg {
  const body: unknown[] = [
    { type: "text", text: meta.branchName, weight: "bold", size: "lg", wrap: true },
    { type: "text", text: `วางแผนโดย: ${meta.operator}`, size: "xxs", color: "#999999", wrap: true },
    ...(fc.momentumPct != null ? [{ type: "text", size: "xxs", wrap: true, contents: [{ type: "span", text: "โมเมนตัมล่าสุด ", color: "#999999" }, pctSpan(fc.momentumPct)] }] : []),
    sep,
  ];
  for (const r of fc.rows) {
    const badge = [r.holiday, r.weather && r.weather.summary !== "อากาศปกติ" ? r.weather.summary : null].filter(Boolean).join(" · ");
    body.push({ type: "box", layout: "vertical", margin: "md", spacing: "none", contents: [
      { type: "box", layout: "horizontal", contents: [
        { type: "text", text: `${r.dowLabel} ${Number(r.date.slice(8, 10))}`, size: "sm", weight: "bold", color: "#0e2724", flex: 5, wrap: true },
        { type: "text", text: r.closed ? "ปิดทำการ" : (r.predictedNett != null ? `~${baht(r.predictedNett)}` : "—"), size: "sm", color: r.closed ? "#b0392f" : "#1a1a2e", align: "end", flex: 5 }
      ] },
      ...(badge ? [{ type: "text", text: badge, size: "xxs", color: "#b8860b", wrap: true }] : []),
      // Cap the notes rendered per day so a heavily-tagged plan can't blow past
      // LINE's flex message size limit (the +N line keeps the count honest).
      ...r.eventNotes.slice(0, 3).map((n) => ({ type: "text", text: `📌 ${n}`, size: "xxs", color: "#7c3aed", wrap: true })),
      ...(r.eventNotes.length > 3 ? [{ type: "text", text: `📌 +${r.eventNotes.length - 3} เพิ่มเติม`, size: "xxs", color: "#7c3aed", wrap: true }] : []),
      ...(r.suggestions.length ? [{ type: "text", text: `• ${r.suggestions[0]}`, size: "xxs", color: "#555555", wrap: true }] : []),
    ] });
  }
  return {
    type: "flex", altText: `แผนล่วงหน้า ${fc.days} วัน · ${meta.branchName}`,
    contents: { type: "bubble", size: "giga",
      header: header("แผนล่วงหน้า", `${fc.days} วันข้างหน้า · ${meta.branchName}`, meta.color, "IKIGAI OS · ANALYTICA"),
      body: { type: "box", layout: "vertical", spacing: "none", paddingAll: "16px", contents: body },
      footer: footer("คาดจากค่าเฉลี่ยรายวัน + โมเมนตัม + วันหยุด/อากาศ · แนะนำโดยน้องฮูก") }
  };
}

// ── แผนดันยอด (sales-push brief, owner 2026-09-18) ───────────────────────────
const VERDICT_COLOR: Record<SalesPushPlan["verdict"], string> = {
  no_data: "#999999", easy: "#0f7a4f", ontrack: "#0f7a4f",
  stretch: "#b8860b", hard: "#b0392f", unrealistic: "#b0392f"
};
export function salesaPushFlex(p: SalesPushPlan, meta: DailyCardMeta): FlexMsg {
  const vColor = VERDICT_COLOR[p.verdict];
  const body: unknown[] = [
    { type: "text", text: meta.branchName, weight: "bold", size: "lg", wrap: true },
    { type: "text", text: `บรีฟโดย: ${meta.operator}`, size: "xxs", color: "#999999", wrap: true },
    sep,
    kv("เป้าหมาย", `${baht(p.targetBaht)} · ${p.days} วัน`, { bold: true, color: "#0f7a4f", size: "md" }),
    kv("ต้องได้เฉลี่ย/วัน", baht(p.requiredPerDay), { size: "xs" }),
  ];
  if (p.hasBaseline) {
    body.push(kv("คาดการณ์ตามปกติ", `${baht(p.baselineProjected)}${p.liftPct != null ? ` (${p.liftPct > 0 ? "+" : ""}${p.liftPct.toFixed(0)}%)` : ""}`, { size: "xs", color: p.gap > 0 ? "#b0392f" : "#0f7a4f" }));
  }
  body.push({ type: "box", layout: "vertical", backgroundColor: "#f4f7f6", cornerRadius: "md", paddingAll: "12px", margin: "sm",
    contents: [{ type: "text", text: p.verdictText, size: "xs", color: vColor, wrap: true }] });
  if (p.advice.length) {
    body.push(sep);
    body.push({ type: "text", text: "สรุปประเด็นสำหรับบรีฟทีม", size: "xs", weight: "bold", color: meta.color });
    p.advice.forEach((line) => body.push({
      type: "box", layout: "horizontal", spacing: "sm", contents: [
        { type: "text", text: "•", size: "sm", color: meta.color, flex: 0 },
        { type: "text", text: line, size: "xs", color: "#333333", wrap: true, flex: 1 }
      ]
    }));
  }
  if (p.topEarners.length) {
    body.push(sep);
    body.push(...menuBlock("เมนูที่ทำรายได้หลัก (ช่วง 4 สัปดาห์)", p.topEarners));
  }
  return {
    type: "flex",
    altText: `แผนผลักดันยอดขาย ${p.days} วัน ${baht(p.targetBaht)} · ${meta.branchName}`,
    contents: {
      type: "bubble", size: "giga",
      header: header("แผนผลักดันยอดขาย · คำแนะนำจากน้องฮูก", `${p.days} วัน · ${meta.branchName}`, meta.color),
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer: footer("สรุปโดยระบบ IKIGAI OS · แผนดันยอดระยะสั้น")
    }
  };
}

// ── ภาพรวมบริษัท รวมทุกสาขา (owner 2026-09-25) ───────────────────────────────
export type CompanyCardMeta = { companyName: string; monthLabel: string; operator: string; color: string };

/** Company-wide sales summary card for the HOD group: total MTD sales + MoM,
 *  monthly + annual target progress, and a per-branch line-up. Mirrors the
 *  ANALYTICA company page (owner 2026-09-25). */
export function salesaCompanyFlex(ov: CompanyOverview, meta: CompanyCardMeta): FlexMsg {
  const t = ov.total;
  const momLine = t.prevSameNett == null
    ? { type: "text", text: "เทียบเดือนก่อน: ยังไม่มีข้อมูลเทียบ", size: "xxs", color: "#bbbbbb", wrap: true }
    : { type: "text", size: "xxs", wrap: true, contents: [
        { type: "span", text: "เทียบเดือนก่อน ", color: "#999999" }, pctSpan(t.momPct),
        { type: "span", text: `  (${baht(t.prevSameNett)})`, color: "#bbbbbb" }
      ] };
  // เทียบปีก่อน (owner 2026-09-27) — only when there is year-ago data to compare.
  const yoyLine = t.lastYearNett == null ? null
    : { type: "text", size: "xxs", wrap: true, contents: [
        { type: "span", text: "เทียบปีก่อน ", color: "#999999" }, pctSpan(t.lastYearPct),
        { type: "span", text: `  (${baht(t.lastYearNett)})`, color: "#bbbbbb" }
      ] };

  const body: unknown[] = [
    { type: "text", text: `รวม ${ov.branchCount} สาขา · สรุปโดย: ${meta.operator}`, size: "xxs", color: "#999999", wrap: true },
    sep,
    kv(`ยอดขายรวม (วันที่ 1–${ov.throughDay})`, baht(t.mtdNett), { bold: true, color: "#0f7a4f", size: "md" }),
    momLine,
    ...(yoyLine ? [yoyLine] : []),
    kv("จำนวนบิลรวม", `${intTh(t.bills)} บิล`, { size: "xs" }),
    kv("ลูกค้ารวม", `${intTh(t.pax)} คน`, { size: "xs" }),
    ...(ov.isCurrentMonth && t.todayNett != null ? [kv("ยอดขายวันนี้ (รวมสาขา)", baht(t.todayNett), { size: "xs" })] : []),
    ...(ov.revshareIncome > 0 ? [{ type: "text", text: `รวมส่วนแบ่งยอดขายรายเดือน ${baht(ov.revshareIncome)} (นอก POS)`, size: "xxs", color: "#7c3aed", wrap: true }] : [])
  ];

  if (ov.target) {
    body.push(sep);
    body.push(kv(`เป้ารายเดือนรวม (${ov.targetedBranchCount} สาขา)`, baht(ov.target.target), { size: "xs" }));
    body.push({ type: "text", size: "xxs", wrap: true, contents: [
      { type: "span", text: "ทำได้ ", color: "#999999" },
      { type: "span", text: `${ov.target.pctOfTarget.toFixed(0)}% ของเป้า`, color: ov.target.pctOfTarget >= 100 ? "#0f7a4f" : "#1a1a2e" },
      { type: "span", text: `  ·  คาดสิ้นเดือน ${baht(ov.target.projectedNett)} (${ov.target.projectedPct.toFixed(0)}%)`, color: ov.target.onTrack ? "#0f7a4f" : "#b8860b" }
    ] });
  }
  if (ov.annual) {
    body.push(kv(`เป้าทั้งปี ${ov.annual.year + 543}`, baht(ov.annual.annualTarget), { size: "xs" }));
    body.push({ type: "text", size: "xxs", wrap: true, contents: [
      { type: "span", text: "YTD ", color: "#999999" },
      { type: "span", text: `${baht(ov.annual.ytdNett)} (${ov.annual.pctOfTarget.toFixed(0)}%)`, color: ov.annual.pctOfTarget >= 100 ? "#0f7a4f" : "#1a1a2e" },
      { type: "span", text: `  ·  คาดสิ้นปี ${ov.annual.projectedPct.toFixed(0)}%`, color: ov.annual.onTrack ? "#0f7a4f" : "#b8860b" }
    ] });
  }

  if (ov.branches.length) {
    body.push(sep);
    body.push({ type: "text", text: "เทียบรายสาขา", size: "xs", weight: "bold", color: "#0e2724", margin: "sm" });
    for (const b of [...ov.branches].sort((a, z) => z.mtdNett - a.mtdNett)) {
      body.push({ type: "box", layout: "horizontal", contents: [
        { type: "text", text: b.branchName, size: "xs", color: "#333333", flex: 5, wrap: true },
        { type: "text", size: "xs", align: "end", flex: 5, wrap: true, contents: [
          { type: "span", text: `${baht(b.mtdNett)}  `, color: "#1a1a2e" }, pctSpan(b.momPct),
          ...(b.pctOfTarget != null ? [{ type: "span", text: `  · ${b.pctOfTarget.toFixed(0)}% เป้า`, color: "#999999" }] : [])
        ] }
      ] });
    }
  }

  return {
    type: "flex",
    altText: `ภาพรวมบริษัท ${meta.monthLabel} · ${meta.companyName} · ${baht(t.mtdNett)}`,
    contents: {
      type: "bubble", size: "giga",
      header: {
        type: "box", layout: "vertical", backgroundColor: meta.color, paddingAll: "16px", spacing: "xs",
        contents: [
          { type: "text", text: "IKIGAI OS · ภาพรวมบริษัท", size: "xxs", color: "#ffffff99" },
          { type: "text", text: meta.companyName, size: "lg", weight: "bold", color: "#ffffff", wrap: true },
          { type: "text", text: `รวมทุกสาขา · ${meta.monthLabel}`, size: "xs", color: "#ffffffcc", wrap: true }
        ]
      },
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer: footer("สรุปโดยระบบ IKIGAI OS · ภาพรวมบริษัทรวมทุกสาขา")
    }
  };
}

/** Push a card to the HOD LINE group via the platform OA. */
export async function notifySalesaHod(lineGroupId: string, flex: FlexMsg): Promise<{ ok: boolean; error?: string }> {
  const token = getPlatformChannel()?.channel_token?.trim() ?? null;
  if (!token) return { ok: false, error: "platform_oa_not_configured" };
  const res = await sendLinePush(token, { to: lineGroupId, messages: [flex] });
  return { ok: res.ok, error: res.error };
}
