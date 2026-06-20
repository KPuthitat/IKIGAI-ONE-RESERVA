import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { askOwlHelp, owlHelpEnabled, helpQuotaRemaining, OwlHelpError } from "@/lib/owl-help";
import { logOwlUsage } from "@/lib/owl-data";
import { owlAiCostBaht } from "@/lib/owl-ai-models";

// POST /api/owl/help — usage-help Q&A for ANY logged-in user. Claude (Haiku)
// answers "วิธีใช้งาน" questions grounded in the FAQ (owl-help.ts). Gated by
// owl_help_enabled + a per-user daily cap to control cost. Logged to
// owl_ai_usage tagged "[help]".

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  if (!owlHelpEnabled()) {
    return NextResponse.json(
      { error: "disabled", message: "น้องฮูก (วิธีใช้) ยังไม่เปิดใช้งาน — แจ้งแอดมินเปิดที่ตั้งค่าระบบ" },
      { status: 400 }
    );
  }

  const remaining = helpQuotaRemaining(user.id);
  if (remaining <= 0) {
    return NextResponse.json(
      { error: "quota", message: "วันนี้ถามครบโควตาแล้วครับ ลองใหม่พรุ่งนี้ หรือดู FAQ ก่อนนะครับ" },
      { status: 429 }
    );
  }

  const body = await req.json().catch(() => ({})) as { question?: string };
  const question = (body.question ?? "").trim();
  if (!question) return NextResponse.json({ error: "no_question", message: "พิมพ์คำถามก่อนครับ" }, { status: 400 });
  if (question.length > 500) {
    return NextResponse.json({ error: "too_long", message: "คำถามยาวเกินไป (สูงสุด 500 ตัวอักษร)" }, { status: 400 });
  }

  const audience = (user.role === "admin" || user.role === "super_admin") ? "admin" : "staff";

  try {
    const r = await askOwlHelp(question, audience);
    // Tag "[help]" so the per-user daily cap can count these separately from
    // the admin finance/HR askOwl rows.
    logOwlUsage({
      model: r.model, inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens,
      question: `[help] ${question}`, userId: user.id
    });
    const costBaht = owlAiCostBaht(r.model, r.usage.input_tokens, r.usage.output_tokens);
    return NextResponse.json({ ok: true, answer: r.answer, costBaht, remaining: remaining - 1 });
  } catch (e) {
    if (e instanceof OwlHelpError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: "help_failed", message: "ถามน้องฮูกไม่สำเร็จ ลองใหม่อีกครั้ง" }, { status: 500 });
  }
}
