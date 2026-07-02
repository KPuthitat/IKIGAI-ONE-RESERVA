import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Public: branches with DELIVERA switched on (customer branch picker).
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = getDb()
    .prepare("SELECT id, name FROM branches WHERE delivera_enabled = 1 ORDER BY name")
    .all() as Array<{ id: number; name: string }>;
  return NextResponse.json({ ok: true, branches: rows });
}
