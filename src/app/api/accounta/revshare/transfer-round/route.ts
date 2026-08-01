import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { getDb } from "@/lib/db";
import {
  isRevshareBranch, getPartner,
  previewTransferRound, sendTransferRound, lastTransferEnd, latestRoundDate
} from "@/lib/revshare-db";
import { revshareWeeklyFlex, notifyRevsharePartner } from "@/lib/revshare-line";
import { salesBaseIncludesVat } from "@/lib/revshare";

// Flexible TRANSFER round (owner 2026-08-01): summarise + settle the partner's
// sales over an ad-hoc [start, end] span — from the day after the last
// transferred day up to a chosen date, not the fixed Mon–Sun weekly bucket
// (e.g. merge a 2-day tail 25–26 with 28–31 → transfer 25–31 once). Can cross a
// month. GET = live preview; POST = mark the days transferred + (if the partner
// has a LINE group) push the transfer card. This is the SALES transfer only —
// the monthly GP settlement bill is unchanged.

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isRevshareBranch(branchId)) {
    return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  }
  const url = new URL(req.url);
  const partnerId = Number(url.searchParams.get("partner"));
  if (!Number.isInteger(partnerId) || partnerId <= 0) {
    return NextResponse.json({ error: "invalid_partner" }, { status: 400 });
  }
  if (!getPartner(partnerId, branchId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Default span: day after the last transferred day → the latest data we have.
  const lastSent = lastTransferEnd(partnerId, branchId);
  const latest = latestRoundDate(partnerId, branchId);
  const dayAfter = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  let start = url.searchParams.get("start");
  let end = url.searchParams.get("end");
  const startExplicit = !!start && ISO.test(start);
  const endExplicit = !!end && ISO.test(end);
  if (!startExplicit) start = lastSent ? dayAfter(lastSent) : latest;
  if (!endExplicit) end = latest;
  if (!start || !end) {
    return NextResponse.json({ error: "no_data", message: "ยังไม่มียอดขายให้สรุป" }, { status: 400 });
  }
  // Defaulted start past end (everything already transferred) → fall back to the
  // last day so the picker opens sensibly instead of erroring; the operator
  // adjusts the dates. Only an EXPLICITLY inverted range is a real error.
  if (start > end) {
    if (startExplicit && endExplicit) {
      return NextResponse.json({ error: "bad_range", message: "วันเริ่มต้องไม่หลังวันจบ" }, { status: 400 });
    }
    start = end;
  }

  const preview = previewTransferRound(partnerId, branchId, start, end);
  if (!preview) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, preview });
}

const PostZ = z.object({
  partner: z.number().int().positive(),
  start: z.string().regex(ISO),
  end: z.string().regex(ISO),
  pin: z.string()
});

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isRevshareBranch(branchId)) {
    return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  }
  const parsed = PostZ.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { partner: partnerId, start, end, pin } = parsed.data;
  if (start > end) {
    return NextResponse.json({ error: "bad_range", message: "วันเริ่มต้องไม่หลังวันจบ" }, { status: 400 });
  }

  // PIN-gated like the daily/weekly sends — the operator verified the figure.
  const status = verifyAdminPin(user.id, pin);
  if (!status.ok) {
    return NextResponse.json({ error: status.reason }, { status: status.reason === "no_pin" ? 400 : 403 });
  }

  const partner = getPartner(partnerId, branchId);
  if (!partner) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const preview = previewTransferRound(partnerId, branchId, start, end);
  if (!preview) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (preview.rows.length === 0) {
    return NextResponse.json({ error: "no_data", message: "ช่วงนี้ไม่มียอดขาย" }, { status: 400 });
  }

  // Mark the days transferred (the cursor for the next round).
  const stamped = sendTransferRound(partnerId, branchId, start, end, user.id);

  // Push the transfer card to the partner's LINE group when configured — same
  // card as the weekly transfer, just with the custom span's label + total.
  let lineSent = false;
  let lineError: string | null = null;
  if (partner.line_group_id) {
    const sellerRow = getDb().prepare(`SELECT name FROM branches WHERE id = ?`).get(branchId) as { name: string } | undefined;
    const flex = revshareWeeklyFlex({
      shop: preview.shop,
      sellerName: sellerRow?.name ?? "",
      weekLabel: preview.label,
      transferAmount: preview.totalSales,
      dayCount: preview.dayCount,
      vatRate: partner.vat_enabled ? partner.vat_rate : 0,
      salesIncludesVat: salesBaseIncludesVat(partner.sales_base)
    });
    const res = await notifyRevsharePartner(partner.line_group_id, flex);
    lineSent = res.ok;
    if (!res.ok) {
      lineError = res.error === "platform_oa_not_configured" ? "ยังไม่ได้ตั้งค่า IKIGAI OS platform OA"
        : res.error === "monthly_quota_exceeded" ? "LINE เกินโควตาข้อความรายเดือนแล้ว"
        : "ส่ง LINE ไม่สำเร็จ (ยอดถูกบันทึกโอนแล้ว)";
    }
  }

  return NextResponse.json({ ok: true, stamped, lineSent, lineError, label: preview.label, total: preview.totalSales });
}
