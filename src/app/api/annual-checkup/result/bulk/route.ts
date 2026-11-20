import { NextResponse } from "next/server";
import { z } from "zod";
import { isAnnualCheckupForbidden, isAnnualCheckupInvalid, recordResult } from "@/lib/annual-checkup-db";
import { ERROR_TEXT, handleClinical } from "@/lib/annual-checkup-api";

// POST {items: [{orderId, valueNum?, valueText?, unit?, refText?, interpretation?}, ...]} — the by-test sheet saves many people at
// once. Each row is its own transaction: one bad row never blocks the others, and every row says how it went.
const Item = z.object({
  orderId: z.number().int().positive(),
  valueNum: z.number().finite().nullable().optional(), valueText: z.string().max(2000).nullable().optional(),
  unit: z.string().max(40).nullable().optional(), refText: z.string().max(200).nullable().optional(),
  interpretation: z.enum(["normal", "abnormal", "follow_up"]).nullable().optional()
});
const Body = z.object({ items: z.array(Item).min(1).max(200) });

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    const results = p.data.items.map(({ orderId, ...data }) => {
      try { return { orderId, ok: true as const, resultId: recordResult(user, orderId, data) }; }
      catch (e) {
        if (isAnnualCheckupForbidden(e) && e.code === "not_recorder") throw e;           // not allowed at all: stop, tell the caller
        if (isAnnualCheckupForbidden(e) || isAnnualCheckupInvalid(e)) return { orderId, ok: false as const, error: e.code, message: ERROR_TEXT[e.code] ?? e.code };
        throw e;
      }
    });
    return NextResponse.json({ ok: true, results, saved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  });
}
