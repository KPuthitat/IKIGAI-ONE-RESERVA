import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getLinkResultFile } from "@/lib/annual-checkup-db";
import { serveStoredFile } from "@/lib/annual-checkup-api";
import { LINK_COOKIE, readLinkToken } from "@/lib/annual-checkup-session";

// GET — PUBLIC but needs the 15-minute window opened by the date of birth; the file must belong to the person behind that link and be released.
export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: { resultId: string } }) {
  const id = Number(params.resultId);
  const linkId = readLinkToken(cookies().get(LINK_COOKIE)?.value);
  if (!Number.isInteger(id) || id <= 0 || linkId == null) return NextResponse.json({ ok: false, error: "not_allowed" }, { status: 403 });
  const f = getLinkResultFile(linkId, id);
  if (!f) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return serveStoredFile(f.path, f.mime);
}
