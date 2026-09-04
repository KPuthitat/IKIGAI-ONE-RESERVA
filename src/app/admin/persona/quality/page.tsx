import Link from "next/link";
import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  listDocuments, QUALITY_TYPE_LABEL, QUALITY_STATUS_LABEL, type QualityVersionStatus
} from "@/lib/quality-docs";
import QualityCreate from "./QualityCreate";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "เอกสารคุณภาพ (WI/WP) · PERSONA" };

const STATUS_CLS: Record<QualityVersionStatus, string> = {
  draft: "bg-slate-100 text-slate-600",
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  obsolete: "bg-slate-100 text-slate-400",
  rejected: "bg-rose-100 text-rose-700"
};

export default function QualityDocsPage() {
  requirePermission("quality.manage");
  const db = getDb();
  const docs = listDocuments(db);
  const branches = db.prepare("SELECT id, name FROM branches ORDER BY name").all() as Array<{ id: number; name: string }>;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">เอกสารคุณภาพ (WI/WP)</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            ควบคุมเอกสารวิธีปฏิบัติงาน — สร้าง แก้ไข อนุมัติ คุมเวอร์ชัน และติดตามการรับทราบของพนักงาน
          </p>
        </div>
        <QualityCreate branches={branches} />
      </div>

      <div className="card overflow-x-auto">
        {docs.length === 0 ? (
          <p className="text-sm text-slate-400 py-8 text-center">ยังไม่มีเอกสาร — กด “+ สร้างเอกสาร” เพื่อเริ่ม</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">รหัส</th>
                <th className="py-2 pr-3">ชื่อเอกสาร</th>
                <th className="py-2 pr-3">ประเภท</th>
                <th className="py-2 pr-3">สาขา</th>
                <th className="py-2 pr-3 text-center">ฉบับที่ใช้</th>
                <th className="py-2 pr-3">สถานะล่าสุด</th>
                <th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-3 font-mono text-slate-700 whitespace-nowrap">{d.doc_code}</td>
                  <td className="py-2 pr-3 font-medium text-slate-800">{d.title}</td>
                  <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{QUALITY_TYPE_LABEL[d.doc_type]}</td>
                  <td className="py-2 pr-3 text-slate-500">{d.branch_name ?? "ทุกสาขา"}</td>
                  <td className="py-2 pr-3 text-center">
                    {d.effective_rev != null
                      ? <span className="text-emerald-700 font-medium">Rev {d.effective_rev}</span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="py-2 pr-3">
                    {d.latest_status && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_CLS[d.latest_status]}`}>
                        {QUALITY_STATUS_LABEL[d.latest_status]}{d.latest_rev != null ? ` (Rev ${d.latest_rev})` : ""}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <Link href={`/admin/persona/quality/${d.id}`} className="text-xs text-brand hover:underline whitespace-nowrap">เปิด →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
