import { NextResponse } from "next/server";
import { requirePayrollAccess } from "@/lib/auth";
import { isDfBranch, wantedTags, importInvoiceLines } from "@/lib/df-db";
import { parseInvoiceBuffer } from "@/lib/df-invoice-parse";

// POST /api/admin/persona/doctor-fee/import  (multipart: file=<xlsx>)
//   Parse a clinic "Invoice Report" export, keep only the lines whose leading
//   [TAG] earns a fee under an active rule, and upsert them (idempotent).

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = requirePayrollAccess();
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!isDfBranch(branchId)) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });

  const tags = wantedTags(branchId);
  if (tags.length === 0) {
    return NextResponse.json({ error: "no_active_rule", message: "ยังไม่มีกฎค่าตอบแทน (rule) ที่เปิดใช้งาน — ตั้งค่ารหัส/เรทก่อน" }, { status: 400 });
  }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "bad_form" }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > 12 * 1024 * 1024) return NextResponse.json({ error: "file_too_large" }, { status: 400 });

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const parsed = parseInvoiceBuffer(buf, tags);
    if (parsed.lines.length === 0) {
      return NextResponse.json({
        error: "no_matching_lines",
        message: `ไม่พบบรรทัดที่ตรงรหัส ${tags.join(", ")} ในไฟล์ — ตรวจว่าเป็นไฟล์ Invoice Report ของคลินิก`
      }, { status: 422 });
    }
    const summary = importInvoiceLines(branchId, parsed.lines, file.name);
    return NextResponse.json({ ok: true, filename: file.name, tags, ...summary, skippedNoDate: parsed.skippedNoDate });
  } catch (e) {
    return NextResponse.json({ error: "parse_failed", message: (e as Error).message }, { status: 422 });
  }
}
