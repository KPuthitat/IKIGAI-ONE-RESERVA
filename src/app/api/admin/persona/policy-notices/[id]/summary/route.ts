import { NextResponse } from "next/server";
import { logPersonaAction } from "@/lib/db";
import { getNotice } from "@/lib/policy-notices";
import { adminGate } from "@/lib/policy-notices-api";
import { SuggestionAiError, summarizeSuggestions } from "@/lib/policy-suggestions-ai";

// POST → ask the AI to digest the anonymous suggestions of a sent notice (stored on the notice, re-runnable)
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const g = adminGate(); if ("error" in g) return g.error;
  const id = Number(params.id);
  const n = getNotice(id);
  if (!n) return NextResponse.json({ error: "not_found", message: "ไม่พบรายการนี้" }, { status: 404 });
  if (n.status !== "published" && n.status !== "closed") return NextResponse.json({ error: "bad_status", message: "สถานะปัจจุบันทำรายการนี้ไม่ได้" }, { status: 409 });
  try {
    const summary = await summarizeSuggestions(id);
    logPersonaAction(g.user.id, "policy_notice_ai_summary", id);
    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    if (e instanceof SuggestionAiError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === "no_suggestions" ? 400 : 502 });
    throw e;
  }
}
