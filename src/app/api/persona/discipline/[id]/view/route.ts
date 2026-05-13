import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getWarning, recordView } from "@/lib/discipline";

// POST /api/persona/discipline/[id]/view — appends an audit row to
// disciplinary_warning_views every time the recipient opens the
// warning page. Called from a useEffect on the staff page so the
// system has indisputable proof of viewership.

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const w = getWarning(id);
  if (!w) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (w.user_id !== user.id) return NextResponse.json({ error: "not_recipient" }, { status: 403 });

  const ua = req.headers.get("user-agent");
  const ip = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip");
  recordView(id, ip, ua);
  return NextResponse.json({ ok: true });
}
