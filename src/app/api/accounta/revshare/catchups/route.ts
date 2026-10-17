import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { logPersonaAction } from "@/lib/db";
import { isRevshareBranch, listCatchups, createCatchup, createCatchupFromFile, reconcileRange, deleteCatchup, CatchupError } from "@/lib/revshare-db";

// ยอดตกสำรวจ — sales found after their day was already imported / sent / settled (owner 2026-10-17).
// Kept apart from the daily rounds; counts in the period it is recorded in. PIN-gated like the daily rows.
//   GET ?partner&year&month  list
//   POST {partner, sales_amount, sales_from?, sales_to?, note?, source?, source_filename?, bill_count?, pin}
//   DELETE ?id&partner&pin   remove one that has not gone out in a transfer yet

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PostZ = z.object({
  partner: z.number().int().positive(),
  sales_amount: z.number().positive().optional(),
  sales_from: z.string().regex(ISO).nullable().optional(), sales_to: z.string().regex(ISO).nullable().optional(),
  note: z.string().max(300).nullable().optional(),
  source: z.enum(["manual", "pos_import"]).optional(), source_filename: z.string().max(200).nullable().optional(),
  bill_count: z.number().int().min(0).nullable().optional(),
  // A whole-span POS file (e.g. 1st of the month → today): store only what is missing = file total − already recorded.
  file_total: z.number().positive().optional(),
  pin: z.string()
});
const CATCHUP_TEXT: Record<string, string> = {
  invalid_amount: "ยอดต้องมากกว่า 0",
  invalid_range: "ช่วงวันที่ไม่ถูกต้อง (ต้องกรอกทั้งวันเริ่มและวันจบ และวันเริ่มต้องไม่หลังวันจบ)",
  day_has_daily: "วันนั้นมียอดรายวันอยู่แล้ว ไม่ใช่ยอดตกสำรวจ — แก้ที่ยอดรายวันแทน",
  nothing_missing: "ไม่พบยอดที่ตกหล่น — ยอดรายวันที่นำเข้าไว้แล้วครบตามไฟล์",
  daily_exceeds_file: "ยอดรายวันที่นำเข้าไว้แล้วมากกว่ายอดในไฟล์ — ตรวจหมวดสินค้าและฐานยอดขายที่เลือกให้ตรงกับที่ใช้นำเข้ารายวัน"
};

function ctx() {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  return { user, branchId, ok: branchId != null && isRevshareBranch(branchId) };
}

export function GET(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const partner = Number(sp.get("partner"));
  const from = sp.get("from"), to = sp.get("to");
  if (from && to) {
    // what is already recorded inside a span — for the whole-span file reconcile
    if (!ISO.test(from) || !ISO.test(to) || from > to || !Number.isInteger(partner)) return NextResponse.json({ error: "bad_params" }, { status: 400 });
    const r = reconcileRange(partner, branchId!, from, to);
    return r ? NextResponse.json({ ok: true, ...r }) : NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const year = Number(sp.get("year")), month = Number(sp.get("month"));
  if (![partner, year, month].every(Number.isInteger)) return NextResponse.json({ error: "bad_params" }, { status: 400 });
  return NextResponse.json({ ok: true, catchups: listCatchups(partner, branchId!, year, month) });
}

export async function POST(req: Request) {
  const { user, branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  const parsed = PostZ.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const pin = verifyAdminPin(user.id, d.pin);
  if (!pin.ok) return NextResponse.json({ error: pin.reason }, { status: pin.reason === "no_pin" ? 400 : 403 });
  try {
    let id: number | null;
    let amount = d.sales_amount ?? 0;
    if (d.file_total != null) {
      if (!d.sales_from || !d.sales_to) return NextResponse.json({ error: "invalid_range", message: CATCHUP_TEXT.invalid_range }, { status: 422 });
      const r = createCatchupFromFile(d.partner, branchId!, { from: d.sales_from, to: d.sales_to, fileTotal: d.file_total, filename: d.source_filename, note: d.note }, user.id);
      id = r?.id ?? null; amount = r?.amount ?? 0;
    } else {
      if (d.sales_amount == null) return NextResponse.json({ error: "invalid_amount", message: CATCHUP_TEXT.invalid_amount }, { status: 422 });
      id = createCatchup(d.partner, branchId!, { ...d, sales_amount: d.sales_amount }, user.id);
    }
    if (!id) return NextResponse.json({ error: "create_failed" }, { status: 400 });
    logPersonaAction(user.id, "revshare_catchup_add", id);
    const now = new Date(Date.now() + 7 * 3600_000);
    return NextResponse.json({ ok: true, id, amount, catchups: listCatchups(d.partner, branchId!, now.getUTCFullYear(), now.getUTCMonth() + 1) });
  } catch (e) {
    if (e instanceof CatchupError) return NextResponse.json({ error: e.code, message: CATCHUP_TEXT[e.code] }, { status: 422 });
    throw e;
  }
}

export function DELETE(req: Request) {
  const { user, branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const id = Number(sp.get("id")), partner = Number(sp.get("partner"));
  if (![id, partner].every((n) => Number.isInteger(n) && n > 0)) return NextResponse.json({ error: "bad_params" }, { status: 400 });
  const pin = verifyAdminPin(user.id, sp.get("pin") ?? "");
  if (!pin.ok) return NextResponse.json({ error: pin.reason }, { status: pin.reason === "no_pin" ? 400 : 403 });
  const r = deleteCatchup(id, partner, branchId!);
  if (r === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (r === "sent") return NextResponse.json({ error: "sent", message: "ยอดนี้รวมในรอบโอนที่ส่งแล้ว ลบไม่ได้" }, { status: 409 });
  logPersonaAction(user.id, "revshare_catchup_delete", id);
  return NextResponse.json({ ok: true });
}
