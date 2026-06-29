import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyBillToken } from "@/lib/accounta-bill-token";
import { submitLineBillDetail } from "@/lib/accounta-db";
import { DOC_TYPES } from "@/lib/accounta";

// POST /api/accounta/line-bill/submit — sender fills the bill detail form opened
// from the LINE card. PUBLIC by design: authorised by the signed token (one
// draft, time-limited), NOT a login session. The draft stays 'draft' for admin
// review (owner 2026-06-29).
const Body = z.object({
  token: z.string().min(1),
  doc_type: z.string().nullable().optional(),
  vendor_name: z.string().trim().max(200).nullable().optional(),
  ocr_tax_id: z.string().trim().max(20).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional(),
  amount_total: z.number().min(0).max(1e9),
  has_tax_invoice: z.boolean().optional(),
  vat_amount: z.number().min(0).max(1e9).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional()
});

const SENDER_FILLED = "ผู้ส่งกรอกรายละเอียดแล้ว";

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const id = verifyBillToken(d.token);
  if (id == null) return NextResponse.json({ error: "invalid_token", message: "ลิงก์หมดอายุหรือไม่ถูกต้อง" }, { status: 403 });

  // Unknown/legacy doc type → null (the picker offers only valid ones anyway).
  const docType = d.doc_type && (DOC_TYPES as readonly string[]).includes(d.doc_type) ? d.doc_type : null;
  const base = (d.note ?? "").replace(new RegExp(`\\s*·?\\s*${SENDER_FILLED}`, "g"), "").trim();
  const note = base ? `${base} · ${SENDER_FILLED}` : SENDER_FILLED;

  const ok = submitLineBillDetail(id, {
    doc_type: docType,
    vendor_name: d.vendor_name ?? null,
    ocr_tax_id: d.ocr_tax_id ?? null,
    category: d.category ?? null,
    amount_total: d.amount_total,
    has_tax_invoice: !!d.has_tax_invoice,
    vat_amount: d.vat_amount ?? 0,
    note
  });
  if (!ok) return NextResponse.json({ error: "not_draft", message: "บิลนี้ถูกตรวจ/บันทึกแล้ว" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
