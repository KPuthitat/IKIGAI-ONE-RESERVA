import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteSignature, getSignature, MemoError, saveSignature } from "@/lib/memos";
import { memoError, memoGate } from "@/lib/memos-api";

// The caller's own drawn signature (PNG data URL). GET → {image|null}; PUT {image} → save; DELETE → remove. Only ever your own.
export const dynamic = "force-dynamic";
const Put = z.object({ image: z.string().max(320_000) });

export async function GET() { const g = memoGate(); if ("error" in g) return g.error; return NextResponse.json({ ok: true, image: getSignature(g.user.id) }); }
export async function PUT(req: Request) {
  const g = memoGate(); if ("error" in g) return g.error;
  const p = Put.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "bad_signature_image", message: "ลายเซ็นไม่ถูกต้อง" }, { status: 400 });
  try { saveSignature(g.user.id, p.data.image); return NextResponse.json({ ok: true }); } catch (e) { if (e instanceof MemoError) return memoError(e); throw e; }
}
export async function DELETE() { const g = memoGate(); if ("error" in g) return g.error; deleteSignature(g.user.id); return NextResponse.json({ ok: true }); }
