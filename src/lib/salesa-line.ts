// SALESA — LINE Flex cards for the HOD group (owner 2026-09-16). A daily sales
// summary (pushed every day the file is imported) and a weekly summary (Mon–Sun,
// pushed the following Monday). Mirrors the revshare card style; pushed to the
// branch's configured HOD group via the platform OA.

import { sendLinePush } from "./line";
import { getPlatformChannel } from "./messaging-channels";
import type { DailyAnalytics, WeeklyAnalytics } from "./salesa-analytics";

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

function header(title: string, subtitle: string): unknown {
  return {
    type: "box", layout: "vertical", backgroundColor: "#0e2724", paddingAll: "16px", spacing: "xs",
    contents: [
      { type: "text", text: "IKIGAI OS · ยอดขายรายวัน", size: "xxs", color: "#7fd6b3" },
      { type: "text", text: title, size: "lg", weight: "bold", color: "#ffffff" },
      { type: "text", text: subtitle, size: "xs", color: "#a9cfc2", wrap: true }
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

export type DailyCardMeta = { branchName: string; operator: string };

// A metric's value + a two-part comparison line (vs prev day · vs avg), each %
// coloured green/red via spans (owner 2026-09-17: % on every heading).
function pctSpan(p: number | null) {
  if (p == null) return { type: "span", text: "—", color: "#bbbbbb" };
  const up = p >= 0;
  return { type: "span", text: `${up ? "▲" : "▼"} ${Math.abs(p).toFixed(1)}%`, color: up ? "#0f7a4f" : "#b0392f" };
}
function metricCompareLine(m: { prevPct: number | null; avgPct: number | null }, avgDays: number): unknown {
  if (m.prevPct == null && m.avgPct == null) {
    return { type: "text", text: "ยังไม่มีข้อมูลเทียบ", size: "xxs", color: "#bbbbbb", wrap: true };
  }
  return {
    type: "text", size: "xxs", wrap: true, contents: [
      { type: "span", text: "เทียบวันก่อน ", color: "#999999" }, pctSpan(m.prevPct),
      { type: "span", text: `   เฉลี่ย ${avgDays} วัน `, color: "#999999" }, pctSpan(m.avgPct)
    ]
  };
}

export function salesaDailyFlex(a: DailyAnalytics, meta: DailyCardMeta): FlexMsg {
  const r = a.row;
  const body: unknown[] = [
    { type: "text", text: meta.branchName, weight: "bold", size: "lg", wrap: true },
    { type: "text", text: `บันทึกโดย: ${meta.operator}`, size: "xxs", color: "#999999", wrap: true },
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
    body.push(metricCompareLine(m, a.avg7Days));
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
  body.push(...menuBlock("🍽️ เมนูทำรายได้สูงสุด", a.topItems));
  body.push(...menuBlock("หมวดทำรายได้สูงสุด", a.topCategories));
  if (a.bottomItems.length) body.push(...menuBlock("เมนูทำรายได้น้อยสุด (ในรายการที่มี)", a.bottomItems));

  return {
    type: "flex",
    altText: `สรุปยอดขายประจำวัน ${a.dateLabel} · ${meta.branchName} · ${baht(r.nett)}`,
    contents: {
      type: "bubble", size: "giga",
      header: header("สรุปยอดขายประจำวัน", `${a.dateLabel} · ${meta.branchName}`),
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
    kv("จำนวนบิลรวม", `${intTh(w.totalBills)} บิล`, { size: "xs" }),
    kv("ลูกค้ารวม", `${intTh(w.totalPax)} คน`, { size: "xs" }),
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
  body.push(...menuBlock("🍽️ เมนูทำรายได้สูงสุดประจำสัปดาห์", w.topItems));
  body.push(...menuBlock("หมวดทำรายได้สูงสุดประจำสัปดาห์", w.topCategories));

  return {
    type: "flex",
    altText: `สรุปยอดขายประจำสัปดาห์ ${w.label} · ${meta.branchName} · ${baht(w.totalNett)}`,
    contents: {
      type: "bubble", size: "giga",
      header: header("สรุปยอดขายประจำสัปดาห์", `${w.label} · ${meta.branchName}`),
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer: footer("สรุปโดยระบบ IKIGAI OS · รอบจันทร์–อาทิตย์")
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
