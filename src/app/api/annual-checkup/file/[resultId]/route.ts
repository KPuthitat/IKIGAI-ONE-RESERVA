import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getResultFileClinical } from "@/lib/annual-checkup-db";
import { handle } from "@/lib/annual-checkup-api";
import { readFileToken } from "@/lib/annual-checkup-session";

// GET /api/annual-checkup/file/[resultId]?t=<signed link> — stream a result file to clinical staff. Needs BOTH the session (and the
// gateway's live eligibility check, which also writes the audit row) AND a link made for this result and this person in the last 5 minutes.
const DATA_ROOT = process.env.HEALTH_DATA_ROOT ?? path.join(process.cwd(), "data", "health");

export async function GET(req: Request, { params }: { params: { resultId: string } }) {
  return handle(async (user) => {
    const id = Number(params.resultId);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
    if (!readFileToken(new URL(req.url).searchParams.get("t"), id, user.id)) return NextResponse.json({ ok: false, error: "link_expired", message: "ลิงก์หมดอายุ กรุณาเปิดหน้านี้ใหม่แล้วกดดูไฟล์อีกครั้ง" }, { status: 403 });
    const f = getResultFileClinical(user, id);
    if (!f) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    const full = path.resolve(DATA_ROOT, f.path);
    if (!full.startsWith(path.resolve(DATA_ROOT) + path.sep)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });   // never leave the data folder
    try {
      const buf = await fs.readFile(full);
      return new NextResponse(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), { headers: { "Content-Type": f.mime, "Content-Disposition": "inline", "Cache-Control": "private, no-store" } });
    } catch { return NextResponse.json({ ok: false, error: "file_missing" }, { status: 404 }); }
  });
}
