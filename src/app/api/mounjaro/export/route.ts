import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { exportMyData, type MjActor } from "@/lib/mounjaro-db";

// GET /api/mounjaro/export — PDPA right-to-access. Returns ALL of the
// acting employee's own Mounjaro data as a JSON download. Scoped by the
// gateway — only their own rows.

export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const data = exportMyData(user as MjActor);
  const body = JSON.stringify(data, null, 2);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="mounjaro-my-data.json"`
    }
  });
}
