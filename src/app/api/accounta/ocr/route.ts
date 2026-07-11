import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { scanBill, OcrError } from "@/lib/accounta-ocr";
import { logOcrUsage, ocrUsageStats, listCategories, findVendorByTaxId, findVendorByName, findDuplicateBill } from "@/lib/accounta-db";
import { ocrCostBaht } from "@/lib/accounta";

// POST /api/accounta/ocr — multipart image → structured bill prefill.
// Logs token usage→baht so the toggle UI can show running spend. The
// returned fields only PRE-FILL the form; nothing is saved here.

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"
]);

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "bad_form" }, { status: 400 }); }
  const file = form.get("image");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "no_file", message: "ไม่พบไฟล์" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "too_large", message: "ไฟล์เกิน 8 MB" }, { status: 400 });
  }
  const mediaType = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json({ error: "bad_type", message: "รองรับเฉพาะรูป PNG / JPG / WebP หรือไฟล์ PDF" }, { status: 400 });
  }

  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");

  try {
    const categories = listCategories().map((c) => c.name);
    const { result, usage, model } = await scanBill({ base64, mediaType, categories });
    logOcrUsage({
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      userId: user.id
    });
    const costBaht = ocrCostBaht(model, usage.input_tokens, usage.output_tokens);
    const stats = ocrUsageStats(new Date().toISOString().slice(0, 7));
    // Auto-match the vendor master: tax id is the most reliable key (prints
    // cleanly even when the name is garbled), then fall back to an exact name.
    const branchId = user.activeBranchId ?? null;
    let matched = result.tax_id ? findVendorByTaxId(result.tax_id, branchId) : null;
    if (!matched && result.vendor_name) matched = findVendorByName(result.vendor_name, branchId);
    const matchedVendor = matched
      ? { id: matched.id, name: matched.name, tax_id: matched.tax_id, category: matched.category, by: result.tax_id && matched.tax_id ? "tax_id" : "name" }
      : null;
    // Duplicate check by invoice number (same เลขที่บิล + same issuer in the branch).
    const dup = result.invoice_no
      ? findDuplicateBill({ branchId, invoiceNo: result.invoice_no, taxId: result.tax_id, vendorName: matched?.name ?? result.vendor_name })
      : null;
    return NextResponse.json({ ok: true, result, matched_vendor: matchedVendor, duplicate: dup, model, costBaht, usage: stats });
  } catch (e) {
    if (e instanceof OcrError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: "ocr_failed", message: "อ่านบิลไม่สำเร็จ" }, { status: 500 });
  }
}
