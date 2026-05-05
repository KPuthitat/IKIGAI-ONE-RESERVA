import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import ExportClient from "./ExportClient";

export const dynamic = "force-dynamic";

export default function ExportPage() {
  requireAdmin();
  const branches = getDb().prepare("SELECT * FROM branches ORDER BY name").all() as Branch[];
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-bold">Export ข้อมูล</h1>
        <p className="text-sm text-slate-500">
          ดาวน์โหลด CSV ของการจอง (รวม source การตลาด) เปิดได้ใน Excel/Google Sheets
        </p>
      </div>
      <ExportClient branches={branches} />
    </div>
  );
}
