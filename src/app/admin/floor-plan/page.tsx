import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch, type TableRow } from "@/lib/db";
import FloorPlanEditor from "./FloorPlanEditor";

export const dynamic = "force-dynamic";

export default function FloorPlanPage() {
  const user = requireAdmin();
  if (!user.activeBranchId) return <div className="card">ยังไม่ได้รับสิทธิ์เข้าสาขา</div>;
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(user.activeBranchId) as Branch;
  const tables = db.prepare(
    "SELECT * FROM tables WHERE branch_id = ? ORDER BY label"
  ).all(branch.id) as TableRow[];

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-bold">ผังโต๊ะ</h1>
        <p className="text-sm text-slate-500">{branch.name} · ลากเพื่อย้ายตำแหน่ง คลิกเพื่อแก้ไข/ลบ</p>
      </div>
      <FloorPlanEditor branchId={branch.id} initialTables={tables} />
    </div>
  );
}
