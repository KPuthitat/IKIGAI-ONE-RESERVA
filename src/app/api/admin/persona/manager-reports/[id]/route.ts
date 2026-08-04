import { NextResponse } from "next/server";
import { getSessionUser, userCanAdminBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { getManagerReport, deleteManagerReport } from "@/lib/manager-reports";

// DELETE /api/admin/persona/manager-reports/[id] — ลบรายงาน. ผู้เขียนเอง หรือ
// แอดมินของสาขานั้นลบได้ (รายงานระดับบริษัทให้ผู้เขียน/super_admin เท่านั้น).
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const row = getManagerReport(db, id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const isAuthor = row.author_user_id === user.id;
  const canBranch = row.branch_id != null && userCanAdminBranch(user, row.branch_id);
  if (!isAuthor && !canBranch) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  deleteManagerReport(db, id);
  logPersonaAction(user.id, "manager_report.delete", id);
  return NextResponse.json({ ok: true });
}
