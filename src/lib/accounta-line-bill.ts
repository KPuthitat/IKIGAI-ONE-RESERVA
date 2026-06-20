// ── ACCOUNTA — ingest a bill photo sent to the LINE OA (server-only) ──
//
// A staff member sends a bill/receipt photo to the IKIGAI OS OA (1:1 or in a
// group). If their LINE id is bound to an employee, we OCR the image and file
// it as a *draft* expense — no branch yet. The admin reviews it in the
// "ร่างรอตรวจ" inbox, assigns สาขา/บริษัท, fixes anything, and confirms; only
// then does it count in the ledger/summaries. Nothing is auto-posted.
// (owner 2026-06-18, 1+2: บิลเข้าไลน์ → ร่าง + จัดหมวดอัตโนมัติ.)
//
// Gated by the same accounta_ocr_enabled toggle as the in-app scanner, so the
// whole path is off until the owner turns OCR on. Dedup is the unique
// line_message_id index — LINE retries slow webhook deliveries.

import { getDb } from "./db";
import { nameWithPrefix } from "./name";
import { sendLinePush, downloadLineContent, accountaBillAckFlex } from "./line";
import { scanBill, ocrEnabled } from "./accounta-ocr";
import {
  listCategories, createExpense, setExpenseDoc, logOcrUsage,
  expenseExistsForLineMessage, findVendorByName
} from "./accounta-db";
import { saveReceiptImage, RECEIPT_ALLOWED_MIME } from "./accounta-receipts";
import { ocrCostBaht, round2, splitMixedBill, isDocType, DOC_TYPE_LABEL, type DocType, type ExpenseInput, type OcrBillResult } from "./accounta";

type SenderRow = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  status: string;
};

function bkkToday(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function ingestLineBill(args: {
  channelToken: string;
  senderUserId: string;
  messageId: string;
  /** 1:1 chat → we reply helpful hints. Group → stay quiet for unbound
   *  senders / disabled features so we don't OCR or spam every photo. */
  isDirect: boolean;
}): Promise<void> {
  const { channelToken, senderUserId, messageId, isDirect } = args;
  const db = getDb();

  const pushText = (text: string) =>
    sendLinePush(channelToken, { to: senderUserId, messages: [{ type: "text", text }] });

  // Feature gate: tied to the OCR toggle. Off → no LINE ingest.
  if (!ocrEnabled()) {
    if (isDirect) await pushText("ระบบอ่านบิลอัตโนมัติยังไม่เปิดใช้งานครับ รบกวนแจ้งแอดมินเปิดที่หน้าตั้งค่าระบบก่อนนะครับ");
    return;
  }

  // Only bound, active employees can file bills (owner: พนักงานที่ผูกไลน์ทุกคน).
  const user = db.prepare(
    "SELECT id, display_name, title_prefix, status FROM users WHERE line_user_id = ?"
  ).get(senderUserId) as SenderRow | undefined;
  if (!user) {
    if (isDirect) await pushText("ไม่พบบัญชีพนักงานที่ผูกไลน์นี้ครับ พิมพ์ 'id' แล้วส่งรหัสให้แอดมินผูกบัญชีก่อนนะครับ");
    return;
  }
  if (user.status === "disabled" || user.status === "resigned") {
    if (isDirect) await pushText("บัญชีของคุณยังไม่พร้อมใช้งานครับ รบกวนติดต่อแอดมิน");
    return;
  }

  // LINE retries deliveries; skip if this exact message already produced a row.
  if (expenseExistsForLineMessage(messageId)) return;

  const senderName = nameWithPrefix(user.title_prefix, user.display_name);

  const content = await downloadLineContent(channelToken, messageId);
  if (!content) {
    if (isDirect) await pushText("ดาวน์โหลดรูปบิลไม่สำเร็จครับ รบกวนส่งใหม่อีกครั้ง");
    return;
  }
  const buffer = content.buffer;
  let mime = content.mime;
  if (!RECEIPT_ALLOWED_MIME.has(mime)) mime = "image/jpeg"; // LINE photos are jpeg

  const base64 = buffer.toString("base64");
  const today = bkkToday();
  const categories = listCategories().map((c) => c.name);

  // OCR is best-effort: a failure still files the photo as a blank draft so
  // the admin can key it manually rather than losing the bill.
  let parsed: OcrBillResult | null = null;
  let usage: { input_tokens: number; output_tokens: number } | null = null;
  let model: string | null = null;
  try {
    const r = await scanBill({ base64, mediaType: mime, categories });
    parsed = r.result; usage = r.usage; model = r.model;
  } catch { /* keep the draft + photo; parsed stays null */ }

  // Vendor memory: if OCR read a known vendor, inherit its remembered
  // category/tax-id link so repeat bills auto-fill (owner 2026-06-18).
  const known = parsed?.vendor_name ? findVendorByName(parsed.vendor_name) : null;
  const cat = parsed?.category ?? known?.category ?? null;
  const docType: DocType | null = parsed?.doc_type && isDocType(parsed.doc_type) ? parsed.doc_type : null;
  const baseNote = `ส่งโดย ${senderName} ทางไลน์`;

  // Attribute the draft to the submitter's own branch + its company (owner
  // 2026-06-18 — a bill a branch's staff sends in belongs to that branch and
  // company). The admin can still change it on review.
  const ub = db.prepare(`
    SELECT b.id AS branch_id, b.company_id AS company_id
    FROM user_branches ub JOIN branches b ON b.id = ub.branch_id
    WHERE ub.user_id = ? ORDER BY ub.branch_id LIMIT 1
  `).get(user.id) as { branch_id: number; company_id: number | null } | undefined;

  // Build one draft row's input from a VAT-resolved amount slice.
  const buildInput = (a: {
    amount: number; hasTax: boolean; vat: number; base: number; note: string;
  }): ExpenseInput => ({
    branch_id: ub?.branch_id ?? null,
    company_id: ub?.company_id ?? null,
    bill_date: parsed?.bill_date || today,
    vendor_id: known?.id ?? null,
    vendor_name: parsed?.vendor_name ?? null,
    doc_type: docType,
    category: cat,
    description: parsed?.description ?? null,
    amount_total: a.amount,
    has_tax_invoice: a.hasTax,
    vat_amount: a.vat,
    base_amount: a.base,
    payment_status: "unpaid",     // admin sets paid/method on review
    payment_method: null,
    paid_date: null,
    note: a.note
  });

  const ocrMeta = model && usage
    ? { source: model, costBaht: ocrCostBaht(model, usage.input_tokens, usage.output_tokens) }
    : undefined;

  // Create one draft row + attach its own copy of the photo. `claimMsgId`
  // is set only on the row that "owns" the LINE message id (dedup); the
  // second split row passes null. Returns the new id, or null if the unique
  // line_message_id index rejected a concurrent retry.
  const createDraftRow = async (input: ExpenseInput, claimMsgId: string | null): Promise<number | null> => {
    let id: number;
    try {
      id = createExpense(user.id, input, ocrMeta, { reviewStatus: "draft", lineMessageId: claimMsgId });
    } catch {
      return null;
    }
    try {
      const p = await saveReceiptImage(buffer, mime, id);
      setExpenseDoc(id, p, mime);
    } catch { /* photo write failed; draft still exists for manual keying */ }
    return id;
  };

  const split = parsed ? splitMixedBill(parsed) : null;
  let firstId: number | null;
  if (split) {
    // Mixed bill → two drafts: one VAT-able, one VAT-exempt (owner 2026-06-18).
    firstId = await createDraftRow(
      buildInput({ amount: split.vatable, hasTax: true, vat: split.vat, base: round2(split.vatable - split.vat), note: `${baseNote} · ส่วนมี VAT` }),
      messageId
    );
    if (firstId == null) return; // concurrent retry already claimed it
    await createDraftRow(
      buildInput({ amount: split.nonvat, hasTax: false, vat: 0, base: split.nonvat, note: `${baseNote} · ส่วนไม่มี VAT` }),
      null
    );
  } else {
    const total = parsed?.amount_total ?? 0;
    const hasTax = parsed?.has_tax_invoice ?? false;
    // Prefer the VAT printed on the bill; else 0/0 → normalise() derives 7%.
    const printedVat = hasTax && parsed?.vat_amount != null ? round2(parsed.vat_amount) : 0;
    firstId = await createDraftRow(
      buildInput({ amount: total, hasTax, vat: printedVat, base: printedVat > 0 ? round2(total - printedVat) : 0, note: baseNote }),
      messageId
    );
    if (firstId == null) return;
  }

  if (model && usage) {
    logOcrUsage({
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      expenseId: firstId,
      userId: user.id
    });
  }

  await sendLinePush(channelToken, {
    to: senderUserId,
    messages: [accountaBillAckFlex({
      senderName,
      vendor: parsed?.vendor_name ?? null,
      amount: parsed?.amount_total ?? null,
      category: cat,
      docTypeLabel: docType ? DOC_TYPE_LABEL[docType] : null,
      billDate: parsed?.bill_date ?? null,
      parsed: !!parsed,
      extraLine: split ? "บิลผสม — แยกเป็น 2 รายการ (มี VAT / ไม่มี VAT)" : null
    })]
  });
}
