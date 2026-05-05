// Endpoint สำหรับ Nginx auth_request — ตรวจว่า user มี session valid มั้ย
// ถ้าใช่ → 200 + headers X-User-Id, X-User-Role (Payroll trust ค่าเหล่านี้)
// ถ้าไม่ → 401

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";

export async function GET() {
  const user = getSessionUser();
  if (!user) {
    return new NextResponse(null, { status: 401 });
  }
  return new NextResponse(null, {
    status: 200,
    headers: {
      "X-User-Id": String(user.id),
      "X-User-Role": user.role,
      "X-User-Name": user.display_name
    }
  });
}
