import { NextResponse } from "next/server";
import { getResultFileClinical } from "@/lib/annual-checkup-db";
import { handleClinical, serveStoredFile } from "@/lib/annual-checkup-api";
import { readFileToken } from "@/lib/annual-checkup-session";

// GET /api/annual-checkup/file/[resultId]?t=<signed link> — stream a result file to clinical staff. Needs BOTH the session (and the
// gateway's live eligibility check, which also writes the audit row) AND a link made for this result and this person in the last 5 minutes.

export async function GET(req: Request, { params }: { params: { resultId: string } }) {
  return handleClinical(async (user) => {
    const id = Number(params.resultId);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
    if (!readFileToken(new URL(req.url).searchParams.get("t"), id, user.id)) return NextResponse.json({ ok: false, error: "link_expired", message: "ลิงก์หมดอายุ กรุณาเปิดหน้านี้ใหม่แล้วกดดูไฟล์อีกครั้ง" }, { status: 403 });
    const f = getResultFileClinical(user, id);
    if (!f) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    return serveStoredFile(f.path, f.mime);
  });
}
