import { NextResponse } from "next/server";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { exportBookingsCsv } from "@/lib/csv";

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "ต้องเป็นแอดมิน" }, { status: 403 });
  }
  const url = new URL(req.url);
  const from = url.searchParams.get("from") || undefined;
  const to = url.searchParams.get("to") || undefined;
  const branchIdRaw = url.searchParams.get("branch_id");
  const branchId = branchIdRaw ? Number(branchIdRaw) : undefined;
  if (branchId && !userHasBranch(user, branchId)) {
    return NextResponse.json({ error: "ไม่มีสิทธิ์เข้าสาขานี้" }, { status: 403 });
  }
  const csv = exportBookingsCsv({ branchId, fromDate: from, toDate: to });
  const filename = `reserva_${from || "all"}_${to || "all"}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`
    }
  });
}
