import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { findPayrollUserByUsername } from "@/lib/payroll-db";
import { createSession, syncUserFromPayroll } from "@/lib/auth";

const Body = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  role: z.enum(["admin", "staff"]).optional()
});

export async function POST(req: Request) {
  const json = await req.json();
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "ข้อมูลไม่ครบ" }, { status: 400 });
  }
  const { username, password, role: requestedRole } = parsed.data;

  // 1) ตรวจ user จาก Payroll DB
  const payrollUser = findPayrollUserByUsername(username);
  if (!payrollUser || !bcrypt.compareSync(password, payrollUser.password_hash)) {
    return NextResponse.json(
      { error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" },
      { status: 401 }
    );
  }

  const actualRole = payrollUser.role === "admin" ? "admin" : "staff";

  // 2) Role ต้องตรงกับ tab ที่เลือกทั้งสองทาง
  //    - เลือก ADMIN แต่ไม่ใช่ admin → ปฏิเสธ
  //    - เลือก STAFF แต่เป็น admin → ปฏิเสธ (กัน admin มาใช้แท็บพนักงาน
  //      แล้วบังเอิญเข้าระบบฝั่งแอดมิน)
  if (requestedRole && requestedRole !== actualRole) {
    const msg = requestedRole === "admin"
      ? "บัญชีนี้ไม่มีสิทธิ์เข้าฝั่งผู้ดูแล"
      : "บัญชีผู้ดูแล กรุณาเลือกแท็บ ADMIN";
    return NextResponse.json({ error: msg }, { status: 403 });
  }

  // 3) sync user → local users (สำหรับ FK ใน sessions)
  syncUserFromPayroll(payrollUser);

  // 4) create session
  createSession(payrollUser.id, null);

  return NextResponse.json({ ok: true, role: actualRole });
}
