import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { setAdminPin, verifyAdminPin, hasAdminPin } from "@/lib/admin-pin";

// POST /api/admin/me/pin
// Body: { new_pin: "1234..", current_pin?: "1234.." }
//
// Set a fresh PIN (when admin has none) or change an existing PIN.
// When the user already has a PIN, current_pin is REQUIRED so
// stealing a logged-in session doesn't let an attacker change the
// PIN out from under the real admin. Super-admin reset path lives
// in a separate endpoint (not in this commit).

const Body = z.object({
  new_pin: z.string().regex(/^\d{4,6}$/, "PIN ต้องเป็นตัวเลข 4-6 หลัก"),
  current_pin: z.string().regex(/^\d{4,6}$/).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin" && user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", message: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง" },
      { status: 400 }
    );
  }

  // When changing an existing PIN, verify the old one first.
  if (hasAdminPin(user.id)) {
    if (!parsed.data.current_pin) {
      return NextResponse.json(
        { error: "current_pin_required", message: "กรุณาใส่ PIN เดิมเพื่อเปลี่ยน" },
        { status: 400 }
      );
    }
    const check = verifyAdminPin(user.id, parsed.data.current_pin);
    if (!check.ok) {
      if (check.reason === "locked") {
        return NextResponse.json(
          { error: "locked", message: "บัญชีถูกล็อก 15 นาที เพราะกรอกผิดเกินกำหนด" },
          { status: 429 }
        );
      }
      return NextResponse.json(
        { error: "wrong_current_pin", message: "PIN เดิมไม่ถูกต้อง" },
        { status: 400 }
      );
    }
  }

  const ok = setAdminPin(user.id, parsed.data.new_pin);
  if (!ok) {
    return NextResponse.json(
      { error: "invalid_pin_format", message: "PIN ต้องเป็นตัวเลข 4-6 หลัก" },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true });
}
