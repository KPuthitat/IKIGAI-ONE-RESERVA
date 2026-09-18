// SALESA — LINE Flex cards for the HOD group (owner 2026-09-16). A daily sales
// summary (pushed every day the file is imported) and a weekly summary (Mon–Sun,
// pushed the following Monday). Mirrors the revshare card style; pushed to the
// branch's configured HOD group via the platform OA.

import { sendLinePush } from "./line";
import { getPlatformChannel } from "./messaging-channels";
import type { DailyAnalytics, WeeklyAnalytics, MonthlyAnalytics } from "./salesa-analytics";

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
function header(title: string, subtitle: string, color: string): unknown {
  return {
    type: "box", layout: "vertical", backgroundColor: color, paddingAll: "16px", spacing: "xs",
    contents: [
      { type: "text", text: "IKIGAI OS · ยอดขายรายวัน", size: "xxs", color: "#ffffff99" },
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
    yoy("เทียบเดือนก่อน", m.prevMonthNett, m.prevMonthPct),
    yoy("เทียบปีก่อน", m.lastYearNett, m.lastYearPct),
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

/** Push a card to the HOD LINE group via the platform OA. */
export async function notifySalesaHod(lineGroupId: string, flex: FlexMsg): Promise<{ ok: boolean; error?: string }> {
  const token = getPlatformChannel()?.channel_token?.trim() ?? null;
  if (!token) return { ok: false, error: "platform_oa_not_configured" };
  const res = await sendLinePush(token, { to: lineGroupId, messages: [flex] });
  return { ok: res.ok, error: res.error };
}
