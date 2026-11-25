import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { getLinkReportData, resolveAccessLink } from "@/lib/annual-checkup-db";
import { LINK_COOKIE, readLinkToken } from "@/lib/annual-checkup-session";
import { buildReport } from "@/lib/health-report/report";
import { loadItems } from "@/lib/health-report/store";
import HealthReportView from "@/app/components/HealthReportView";
import DobForm from "./DobForm";

export const dynamic = "force-dynamic";
// A page of someone's health results must not be indexed or cached.
export const metadata: Metadata = { title: "รายงานผลการตรวจสุขภาพ", robots: { index: false, follow: false } };

const Shell = ({ children }: { children: React.ReactNode }) => <main className="min-h-screen bg-white"><div className="mx-auto max-w-3xl px-4 py-6">{children}</div></main>;

export default function LinkReportPage({ params }: { params: { token: string } }) {
  const st = resolveAccessLink(params.token);
  if (!st) return <Shell><p className="text-center text-slate-700 py-16">ลิงก์นี้ไม่ถูกต้อง กรุณาตรวจสอบลิงก์ หรือขอลิงก์ใหม่จากผู้ดูแล</p></Shell>;
  if (!st.usable && st.reason !== "locked") return <Shell><p className="text-center text-slate-700 py-16">ลิงก์นี้{st.reason === "expired" ? "หมดอายุแล้ว" : "ถูกยกเลิกแล้ว"} กรุณาขอลิงก์ใหม่จากผู้ดูแล</p></Shell>;
  if (!st.usable) return <Shell><p className="text-center text-slate-700 py-16">ลิงก์ถูกล็อกชั่วคราวเพราะกรอกข้อมูลผิดหลายครั้ง กรุณาลองใหม่ภายหลัง หรือติดต่อผู้ดูแล</p></Shell>;
  const open = readLinkToken(cookies().get(LINK_COOKIE)?.value) === st.id;
  if (!open) return <Shell><DobForm token={params.token} /></Shell>;
  const d = getLinkReportData(st.id);
  if (!d) return <Shell><p className="text-center text-slate-700 py-16">ผลตรวจยังไม่เปิดให้ดู หรือลิงก์ใช้ไม่ได้แล้ว</p></Shell>;
  const db = getDb();
  const texts = Object.fromEntries((db.prepare("SELECT key, title_th, body_th FROM annual_checkup_explanations").all() as Array<{ key: string; title_th: string | null; body_th: string }>).map((r) => [r.key, { title: r.title_th, body: r.body_th }]));
  const consultUrl = (db.prepare("SELECT value FROM annual_checkup_config WHERE key = 'consult_url'").get() as { value: string | null } | undefined)?.value?.trim() || null;
  const report = buildReport(d, loadItems(db), texts, new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10));
  return <Shell><HealthReportView report={report} consultUrl={consultUrl} pdfHref="/api/annual-checkup/link/report-pdf" fileHref={(id) => `/api/annual-checkup/link/file/${id}`} /></Shell>;
}
