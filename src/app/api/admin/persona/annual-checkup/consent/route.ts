import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { publishConsentVersion } from "@/lib/annual-checkup-employee";

// POST {version, body} — super_admin publishes a new PDPA consent text; everyone is asked to accept it again.
const Body = z.object({ version: z.string().min(1).max(20), body: z.string().min(1).max(8000) });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") return NextResponse.json({ ok: false, error: "super_admin_only", message: "เฉพาะเจ้าของระบบ" }, { status: 403 });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "กรุณากรอกเลขเวอร์ชันและข้อความ" }, { status: 400 });
  try { publishConsentVersion(user.id, p.data.version, p.data.body); return NextResponse.json({ ok: true }); }
  catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (m === "version_exists") return NextResponse.json({ ok: false, error: m, message: "มีเลขเวอร์ชันนี้อยู่แล้ว" }, { status: 422 });
    return NextResponse.json({ ok: false, error: "invalid_body", message: "บันทึกไม่สำเร็จ" }, { status: 422 });
  }
}
