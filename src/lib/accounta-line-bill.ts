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
import { sendLinePush, sendLineReply, showLineLoading, downloadLineContent, accountaBillVerifyFlex } from "./line";
import type { LineMessage } from "./line";
import { scanBill, ocrEnabled } from "./accounta-ocr";
import {
  listCategories, createExpense, setExpenseDoc, logOcrUsage,
  expenseExistsForLineMessage, findVendorByTaxId, markDraftSenderVerify
} from "./accounta-db";
import { saveReceiptImage, RECEIPT_ALLOWED_MIME } from "./accounta-receipts";
import { ocrCostBaht, round2, type ExpenseInput, type OcrBillResult } from "./accounta";
import { signBillToken } from "./accounta-bill-token";

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");

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
  /** Webhook reply token — reply messages are FREE (don't burn the monthly push
   *  quota). Single-use + short-lived; we fall back to push if it fails. */
  replyToken?: string;
  /** 1:1 chat → we reply helpful hints. Group → stay quiet for unbound
   *  senders / disabled features so we don't OCR or spam every photo. */
  isDirect: boolean;
}): Promise<void> {
  const { channelToken, senderUserId, messageId, replyToken, isDirect } = args;
  const db = getDb();

  // Reply first (free, works even when the monthly push quota is exhausted —
  // owner 2026-06-30: cards stopped after quota ran out); push only as fallback.
  // Single reply per ingest (one path ends in exactly one say()).
  let replyUsed = false;
  const say = async (messages: LineMessage[]) => {
    if (replyToken && !replyUsed) {
      replyUsed = true;
      const r = await sendLineReply(channelToken, replyToken, messages);
      if (r.ok) return;
    }
    await sendLinePush(channelToken, { to: senderUserId, messages });
  };
  const pushText = (text: string) => say([{ type: "text", text }]);

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

  // Show the loading "…" animation right away — OCR on a full-size photo takes a
  // few seconds and otherwise looks like nothing is happening (owner 2026-06-30).
  if (isDirect) await showLineLoading(channelToken, senderUserId);

  const senderName = nameWithPrefix(user.title_prefix, user.display_name);

  const content = await downloadLineContent(channelToken, messageId);
  if (!content) {
    if (isDirect) await pushText("ดาวน์โหลดรูปบิลไม่สำเร็จครับ รบกวนส่งใหม่อีกครั้ง");
    return;
  }
  const buffer = content.buffer;
  let mime = content.mime;
  // LINE forwards a file's content-type inconsistently (often
  // application/octet-stream for a PDF), which used to get mis-coerced to jpeg
  // and made the OCR read a PDF as a broken image — "อ่านไม่ออก" (owner 2026-06-25).
  // Sniff the magic bytes so a real PDF is always sent as a document block.
  const isPdfBytes = buffer.length > 4 && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
  if (isPdfBytes) mime = "application/pdf";
  else if (!RECEIPT_ALLOWED_MIME.has(mime)) mime = "image/jpeg"; // LINE photos are jpeg

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

  // Attribute the draft to the submitter's own branch + its company (owner
  // 2026-06-18 — a bill a branch's staff sends in belongs to that branch and
  // company). The admin can still change it on review.
  const ub = db.prepare(`
    SELECT b.id AS branch_id, b.company_id AS company_id
    FROM user_branches ub JOIN branches b ON b.id = ub.branch_id
    WHERE ub.user_id = ? ORDER BY ub.branch_id LIMIT 1
  `).get(user.id) as { branch_id: number; company_id: number | null } | undefined;
  const branchId = ub?.branch_id ?? null;

  // Vendor matching — by the 13-digit เลขผู้เสียภาษี ONLY (owner 2026-06-27). OCR's
  // job is now just to read the tax id + the bill total; it no longer guesses
  // the vendor name or category off the image. A tax id that matches the
  // branch's vendor master attributes the bill to that vendor (canonical name);
  // an unreadable or unknown tax id leaves the draft's ผู้จำหน่าย blank — a plain
  // "รอตรวจ" draft for the admin to complete. The sender confirms what we matched
  // via the verify card below.
  const taxId = (parsed?.tax_id ?? "").replace(/\D/g, "");
  const known = taxId.length >= 10 ? findVendorByTaxId(taxId, branchId) : null;
  const vendorName = known?.name ?? null;
  const baseNote = `ส่งโดย ${senderName} ทางไลน์`;

  const ocrMeta = model && usage
    ? { source: model, costBaht: ocrCostBaht(model, usage.input_tokens, usage.output_tokens) }
    : undefined;

  // Create one draft row + attach its own copy of the photo. `claimMsgId` owns
  // the LINE message id (dedup). Returns the new id, or null if the unique
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

  // A single draft — amount from OCR, VAT as printed on the bill (if any). No
  // mixed-bill split / no auto-category: those are now the admin's call on review.
  const total = parsed?.amount_total ?? 0;
  const hasTax = parsed?.has_tax_invoice ?? false;
  const printedVat = hasTax && parsed?.vat_amount != null ? round2(parsed.vat_amount) : 0;
  const firstId = await createDraftRow({
    branch_id: ub?.branch_id ?? null,
    company_id: ub?.company_id ?? null,
    bill_date: parsed?.bill_date || today,
    vendor_id: known?.id ?? null,
    vendor_name: vendorName,
    doc_type: null,
    category: null,
    ocr_tax_id: taxId.length >= 10 ? taxId : null,
    description: null,
    amount_total: total,
    has_tax_invoice: hasTax,
    vat_amount: printedVat,
    base_amount: printedVat > 0 ? round2(total - printedVat) : 0,
    payment_status: "unpaid",     // admin sets paid/method on review
    payment_method: null,
    paid_date: null,
    due_date: null,               // admin sets the credit-term due date on review
    note: baseNote
  }, messageId);
  if (firstId == null) return; // concurrent retry already claimed it

  if (model && usage) {
    logOcrUsage({
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      expenseId: firstId,
      userId: user.id
    });
  }

  // Ask the sender to eyeball ผู้จำหน่าย (matched by tax id) + ยอด and tap
  // ถูกต้อง / ไม่ตรง. Their answer is recorded on the draft for the admin (see
  // handleBillVerifyPostback). Nothing is posted to the ledger from this card.
  await say([accountaBillVerifyFlex({
    expenseId: firstId,
    senderName,
    vendorName,
    amount: parsed?.amount_total ?? null,
    billDate: parsed?.bill_date ?? null,
    taxId: taxId.length >= 10 ? taxId : null,
    formUrl: `${PUBLIC_BASE}/bill/${signBillToken(firstId)}`
  })]);
}

/** Handle a tap on the "ตรวจสอบบิล" verify card (postback acct_bill_ok /
 *  acct_bill_fix). Records the sender's answer on their own draft and replies.
 *  Returns true if the postback was one of ours (handled). */
export async function handleBillVerifyPostback(args: {
  channelToken: string;
  senderUserId: string;
  data: string;
}): Promise<boolean> {
  const m = args.data.match(/^acct_bill_(ok|fix)=(\d+)$/);
  if (!m) return false;
  const ok = m[1] === "ok";
  const id = Number(m[2]);
  const db = getDb();
  const user = db.prepare("SELECT id FROM users WHERE line_user_id = ?")
    .get(args.senderUserId) as { id: number } | undefined;
  const pushText = (text: string) =>
    sendLinePush(args.channelToken, { to: args.senderUserId, messages: [{ type: "text", text }] });
  if (!user) { await pushText("ไม่พบบัญชีพนักงานที่ผูกไลน์นี้ครับ"); return true; }
  const updated = markDraftSenderVerify(id, user.id, ok);
  if (!updated) { await pushText("รายการนี้ถูกตรวจหรือลงบัญชีไปแล้ว หรือไม่พบในระบบครับ"); return true; }
  await pushText(ok
    ? "รับทราบครับ ทำเครื่องหมายว่าตรวจแล้วถูกต้อง — ทีมบัญชีจะลงรายการให้ครับ"
    : "รับทราบครับ ทำเครื่องหมายว่ายังไม่ตรง — ทีมบัญชีจะตรวจแก้ก่อนลงรายการครับ");
  return true;
}
