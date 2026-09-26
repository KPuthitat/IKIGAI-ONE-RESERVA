// Client-safe CLINICA helpers (no db import) — shared by the server analytics
// (clinica-analytics), the LINE card (salesa-line) and the client report
// preview (ReportaClient), so the paid/รอเบิก split is computed one way
// everywhere. owner 2026-09-26.

/** Paid share of billed net, clamped to [0,100] (an overpayment/credit can push
 *  paid > billNet). รอเบิก% is then 100 − this. */
export function clinicaPaidPct(c: { paid: number; billNet: number }): number {
  return c.billNet > 0 ? Math.min(100, Math.max(0, Math.round((c.paid / c.billNet) * 100))) : 0;
}
