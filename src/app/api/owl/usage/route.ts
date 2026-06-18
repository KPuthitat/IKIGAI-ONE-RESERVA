import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { aiUsageSummary, bkkMonth } from "@/lib/owl-data";

// GET /api/owl/usage — admin-only running Claude API spend (bill OCR + น้องฮูก),
// this month + all-time, so the owl can tell the admin how much has been used.

export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const isAdmin = user.role === "admin" || user.role === "super_admin";
  if (!isAdmin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true, usage: aiUsageSummary(bkkMonth()) });
}
