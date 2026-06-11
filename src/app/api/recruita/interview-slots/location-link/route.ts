import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { updateSystemSettings } from "@/lib/db";

// POST /api/recruita/interview-slots/location-link  (admin)
//   Body: { map_url }
//
// Set the interview venue map/navigation link right from the interview-
// scheduling page (owner 2026-06-11: "ยังไม่มีให้แปะลิงค์สถานที่นัด
// สัมภาษณ์"). Stored in the same system_settings.recruita_interview_map_url
// the invite-card "นำทางมาสถานที่นัดสัมภาษณ์" button uses — so one link
// drives everything. Empty string clears it. Admin-accessible (the full
// /admin/system-settings form is super_admin-only).

const Body = z.object({ map_url: z.string().max(1000) });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad_body" }, { status: 400 });
  }
  const url = parsed.data.map_url.trim();
  // Reject obvious non-URLs (but allow empty = clear).
  if (url && !/^https?:\/\//i.test(url)) {
    return NextResponse.json(
      { ok: false, error: "bad_url", message: "ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://" },
      { status: 400 }
    );
  }
  updateSystemSettings({ recruita_interview_map_url: url }, user.id);
  return NextResponse.json({ ok: true });
}
