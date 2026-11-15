import { NextResponse } from "next/server";
import { getMyResultFile } from "@/lib/annual-checkup-db";
import { ERROR_TEXT, handle, isViewOpen, serveStoredFile } from "@/lib/annual-checkup-api";
import { readFileToken } from "@/lib/annual-checkup-session";
import { hasConsented } from "@/lib/annual-checkup-employee";

// GET /api/annual-checkup/me/file/[resultId]?t=<signed link> — an employee opens the file of their OWN released result. Needs the
// session, consent, the open PIN window, a link made for this result and this person in the last 5 minutes, and the gateway's own-row check.
export async function GET(req: Request, { params }: { params: { resultId: string } }) {
  return handle(async (user) => {
    const id = Number(params.resultId);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
    if (!hasConsented(user.id)) return NextResponse.json({ ok: false, error: "consent_required", message: ERROR_TEXT.consent_required }, { status: 403 });
    if (!isViewOpen(user)) return NextResponse.json({ ok: false, error: "view_locked", message: ERROR_TEXT.view_locked }, { status: 403 });
    if (!readFileToken(new URL(req.url).searchParams.get("t"), id, user.id)) return NextResponse.json({ ok: false, error: "link_expired", message: "ลิงก์หมดอายุ กรุณาเปิดหน้านี้ใหม่แล้วกดดูไฟล์อีกครั้ง" }, { status: 403 });
    const f = getMyResultFile(user, id);
    if (!f) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    return serveStoredFile(f.path, f.mime);
  });
}
