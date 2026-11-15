import { NextResponse } from "next/server";
import { handle } from "@/lib/annual-checkup-api";
import { recordConsent } from "@/lib/annual-checkup-employee";

// POST — the employee accepts the PDPA notice currently in force (recorded with the version and their IP).
export async function POST(req: Request) {
  return handle(async (user) => {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    recordConsent(user.id, ip);
    return NextResponse.json({ ok: true });
  });
}
