import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getProgramStats, type MjActor } from "@/lib/mounjaro-db";

// GET /api/admin/mounjaro-hr/export — CSV of the aggregate program stats.
// HR / super_admin only. No per-person data.

export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!(user.is_hr_analytics === 1 || user.role === "super_admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const s = getProgramStats(user as MjActor);
  const rows: Array<[string, number]> = [
    ["total_enrolled", s.total_enrolled ?? 0],
    ["active", s.active_count ?? 0],
    ["pending", s.pending_count ?? 0],
    ["withdrawn", s.withdrawn_count ?? 0],
    ["completed", s.completed_count ?? 0]
  ];
  const csv = "metric,value\n" + rows.map(([k, v]) => `${k},${v}`).join("\n") + "\n";
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="mounjaro-program-stats.csv"`
    }
  });
}
