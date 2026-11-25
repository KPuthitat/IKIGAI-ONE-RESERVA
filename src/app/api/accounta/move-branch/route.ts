import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { listMoves, MoveRefused, moveRows } from "@/lib/accounta-move";

// POST {kind: "expense"|"income", ids: number[], toBranchId, reason?} — move bills / income to another branch (one or many).
//   The user needs ACCOUNTA 'confirm' access on both the source and the target branch. Rows the system owns are refused with a reason.
// GET  ?limit= — recent moves (history) for the branches the user can see.
export const dynamic = "force-dynamic";
const Body = z.object({ kind: z.enum(["expense", "income"]), ids: z.array(z.number().int().positive()).min(1).max(300), toBranchId: z.number().int().positive(), reason: z.string().max(300).nullable().optional() });

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  try {
    const results = moveRows(user, p.data.kind, p.data.ids, p.data.toBranchId, p.data.reason ?? null);
    return NextResponse.json({ ok: true, results, moved: results.filter((r) => r.status === "moved").length });
  } catch (e) {
    if (e instanceof MoveRefused) return NextResponse.json({ ok: false, error: e.code, message: e.message }, { status: e.code === "no_access" ? 403 : 422 });
    throw e;
  }
}

export async function GET(req: Request) {
  const user = requirePermission("accounta.manage");
  const limit = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 40));
  return NextResponse.json({ ok: true, moves: listMoves(user, limit) });
}
