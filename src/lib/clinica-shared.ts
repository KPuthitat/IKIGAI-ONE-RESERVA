// Client-safe CLINICA helpers (no db import) — shared by the server analytics
// (clinica-analytics), the LINE card (salesa-line) and the client report
// preview (ReportaClient), so the paid/รอเบิก split is computed one way
// everywhere. owner 2026-09-26.

/** Paid share of billed net, clamped to [0,100] (an overpayment/credit can push
 *  paid > billNet). รอเบิก% is then 100 − this. */
export function clinicaPaidPct(c: { paid: number; billNet: number }): number {
  return c.billNet > 0 ? Math.min(100, Math.max(0, Math.round((c.paid / c.billNet) * 100))) : 0;
}

export type ReceiptChannelKind = "cash" | "bank" | "receivable";

/** Classify a Receipt Report "ช่องทางชำระ" value: 'เงินสด (…)' → cash,
 *  'อื่นๆ (ประกันกลุ่ม …)' → receivable (the HIS books the payer's share there),
 *  everything else (ธนาคาร, บัตร, QR …) is money through a non-cash channel →
 *  bank. Only 'อื่นๆ' is known to be a receivable, so an unseen channel name
 *  never makes real cash-in vanish. */
export function receiptChannelKind(channel: string): ReceiptChannelKind {
  const c = (channel ?? "").trim();
  if (c.startsWith("เงินสด")) return "cash";
  if (c.startsWith("อื่นๆ")) return "receivable";
  return "bank";
}

/** 'ธนาคาร (ธนาคารกสิกรไทย KSHOP)' → 'ธนาคารกสิกรไทย KSHOP'; 'เงินสด (เงินสด)' → 'เงินสด'. */
export function receiptChannelLabel(channel: string): string {
  const c = (channel ?? "").trim();
  const m = /\((.+)\)\s*$/.exec(c);
  return (m ? m[1] : c).trim() || c;
}

/** Percent change used only to pick the mascot's mood on the clinic month headline.
 *  The printed MoM figure compares the (possibly part-way) month with the WHOLE
 *  previous month, so early in a month it is always negative. For the current month
 *  this compares the run-rate projection (net so far ÷ days elapsed × days in month)
 *  with last month instead; a finished month uses the printed figure as-is. */
export function clinicaMonthMoodPct(
  c: { year: number; month: number; billNet: number; prevBillNet: number | null; billNetMomPct: number | null },
  todayIso: string
): number | null {
  const [ty, tm, td] = todayIso.split("-").map(Number);
  const cmp = c.year * 12 + c.month - (ty * 12 + tm);
  if (cmp > 0) return null;                         // future month
  if (cmp < 0) return c.billNetMomPct;              // finished month
  if (!c.prevBillNet || c.prevBillNet <= 0) return null;
  const dim = new Date(Date.UTC(c.year, c.month, 0)).getUTCDate();
  const projected = (c.billNet / Math.max(1, td)) * dim;
  return ((projected - c.prevBillNet) / c.prevBillNet) * 100;
}
