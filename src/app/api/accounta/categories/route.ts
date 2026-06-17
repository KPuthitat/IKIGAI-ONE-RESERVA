import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { listCategories, createCategory } from "@/lib/accounta-db";

// GET  /api/accounta/categories — active expense categories (picklist)
// POST /api/accounta/categories — add a category (owner-extensible)

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().max(10).nullable().optional()
});

export async function GET() {
  requirePermission("accounta.manage");
  return NextResponse.json({ ok: true, categories: listCategories() });
}

export async function POST(req: Request) {
  requirePermission("accounta.manage");
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const id = createCategory(parsed.data);
  return NextResponse.json({ ok: true, id, categories: listCategories() });
}
