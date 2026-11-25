// Shared by the three download routes: the Report model + consult link + file name for one person. Server only.
import { getDb } from "../db";
import type { ReportData } from "../annual-checkup-db";
import { contentDisposition, token } from "../download-name";
import { buildReport, type Report } from "./report";
import { loadItems } from "./store";

export function reportFor(d: ReportData): { report: Report; consultUrl: string | null } {
  const db = getDb();
  const texts = Object.fromEntries((db.prepare("SELECT key, title_th, body_th FROM annual_checkup_explanations").all() as Array<{ key: string; title_th: string | null; body_th: string }>).map((r) => [r.key, { title: r.title_th, body: r.body_th }]));
  const consultUrl = (db.prepare("SELECT value FROM annual_checkup_config WHERE key = 'consult_url'").get() as { value: string | null } | undefined)?.value?.trim() || null;
  return { report: buildReport(d, loadItems(db), texts, new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)), consultUrl };
}

/** HEALTHREPORTA5_<EMPLOYEE CODE or NAME>_<YEAR>.pdf — English, upper case, no spaces (same scheme as the payroll files). */
export function reportDisposition(d: ReportData, disposition: "inline" | "attachment" = "attachment"): string {
  const who = token(d.person.employee_code, `R${d.round.id}`);
  return contentDisposition(disposition, ["HealthReportA5", who, d.round.year_be != null ? String(d.round.year_be - 543) : `R${d.round.id}`].join("_"), "pdf");
}
