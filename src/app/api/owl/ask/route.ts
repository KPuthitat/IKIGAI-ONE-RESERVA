import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { askOwl, owlAiEnabled, OwlAiError } from "@/lib/owl-ai";
import { logOwlUsage, owlUsageStats } from "@/lib/owl-data";
import { owlAiCostBaht } from "@/lib/owl-ai-models";

// POST /api/owl/ask — admin-only natural-language Q&A over ACCOUNTA + PERSONA.
// The model answers via safe data tools (owl-ai.ts); numbers come from the DB,
// never the model. Surfaces financial + HR figures, so it's gated to admins.

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const isAdmin = user.role === "admin" || user.role === "super_admin";
  if (!isAdmin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  if (!owlAiEnabled()) {
    return NextResponse.json(
      { error: "disabled", message: "น้องฮูก (AI) ยังไม่เปิดใช้งาน — เปิดได้ที่ตั้งค่าระบบ" },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({})) as { question?: string };
  const question = (body.question ?? "").trim();
  if (!question) return NextResponse.json({ error: "no_question", message: "พิมพ์คำถามก่อนครับ" }, { status: 400 });
  if (question.length > 1000) {
    return NextResponse.json({ error: "too_long", message: "คำถามยาวเกินไป (สูงสุด 1000 ตัวอักษร)" }, { status: 400 });
  }

  try {
    const r = await askOwl(question);
    logOwlUsage({
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      question,
      userId: user.id
    });
    const costBaht = owlAiCostBaht(r.model, r.inputTokens, r.outputTokens);
    const stats = owlUsageStats(new Date().toISOString().slice(0, 7));
    return NextResponse.json({ ok: true, answer: r.answer, costBaht, usage: stats });
  } catch (e) {
    if (e instanceof OwlAiError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: "ask_failed", message: "ถามน้องฮูกไม่สำเร็จ ลองใหม่อีกครั้ง" }, { status: 500 });
  }
}
