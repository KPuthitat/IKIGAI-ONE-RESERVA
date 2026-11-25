import type { Metadata } from "next";
import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { SECTIONS } from "@/lib/health-report/catalog";
import SettingsClient from "./SettingsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ตั้งค่าเล่มผลตรวจสุขภาพ · PERSONA" };

export default function HealthReportSettingsPage() {
  requireSuperAdmin();
  const db = getDb();
  const cfg = Object.fromEntries((db.prepare("SELECT key, value FROM annual_checkup_config").all() as Array<{ key: string; value: string | null }>).map((r) => [r.key, r.value ?? ""]));
  const items = db.prepare("SELECT id, code, section, name_en, unit, ref_text, plausible_min AS pmin, plausible_max AS pmax, needs_check AS needsCheck, kind FROM annual_checkup_items ORDER BY sort_no, id").all() as Array<{ id: number; code: string; section: string; name_en: string; unit: string | null; ref_text: string | null; pmin: number | null; pmax: number | null; needsCheck: number; kind: string }>;
  const refs = db.prepare("SELECT item_id AS itemId, sex, age_min AS ageMin, age_max AS ageMax, low, high, low_incl AS lowIncl, high_incl AS highIncl FROM annual_checkup_item_refs ORDER BY id").all() as Array<{ itemId: number; sex: "M" | "F" | "A"; ageMin: number | null; ageMax: number | null; low: number | null; high: number | null; lowIncl: number; highIncl: number }>;
  const expl = db.prepare("SELECT key, title_th AS title, body_th AS body FROM annual_checkup_explanations ORDER BY key").all() as Array<{ key: string; title: string | null; body: string }>;
  const templates = db.prepare("SELECT id, section, kind, text, active FROM annual_checkup_note_templates ORDER BY section, kind, sort_no, id").all() as Array<{ id: number; section: string; kind: "summary" | "recommendation"; text: string; active: number }>;
  return (
    <div className="space-y-4">
      <Link href="/admin/persona/annual-checkup" className="text-sm text-slate-500 hover:text-brand">← ตรวจสุขภาพประจำปี</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ตั้งค่าเล่มผลตรวจสุขภาพ</h1>
        <p className="text-sm text-slate-500">แก้ได้โดยไม่ต้องแก้โค้ด: ลิงก์ปรึกษาแพทย์ (QR) · เกณฑ์แจ้งเตือนค่าวิกฤต · หน่วยและค่าอ้างอิงตามเพศและอายุ · ข้อความคำอธิบาย "รายการนี้คืออะไร" · ข้อความสำเร็จรูปของแพทย์ รายการที่มี ⚠ คือที่ยังรอแพทย์ยืนยัน</p>
      </div>
      <SettingsClient cfg={cfg} items={items} refs={refs.map((r) => ({ ...r, lowIncl: r.lowIncl === 1, highIncl: r.highIncl === 1 }))} expl={expl} templates={templates.map((t) => ({ ...t, active: t.active === 1 }))} sections={SECTIONS.map((s) => ({ key: s.key, th: s.th }))} />
    </div>
  );
}
