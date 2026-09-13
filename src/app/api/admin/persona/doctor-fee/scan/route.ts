import { NextResponse } from "next/server";
import { requirePayrollAccess } from "@/lib/auth";
import { isDfBranch, activeRules } from "@/lib/df-db";
import { scanInvoiceTags } from "@/lib/df-invoice-parse";

// POST /api/admin/persona/doctor-fee/scan  (multipart: file=<xlsx>)
//   Scan a clinic "Invoice Report" for every service code present (owner
//   2026-09-13). Returns each detected [TAG] with its stats and the rate it
//   already earns (if any active rule covers it), so the admin can just tick the
//   codes that count + set a rate — no typing codes. Reads the file only; no
//   write, no rule needed yet.

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = requirePayrollAccess();
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!isDfBranch(branchId)) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "bad_form" }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > 12 * 1024 * 1024) return NextResponse.json({ error: "file_too_large" }, { status: 400 });

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const { tags, totalRows } = scanInvoiceTags(buf);
    if (tags.length === 0) {
      return NextResponse.json({
        error: "no_codes",
        message: "ไม่พบรหัสบริการในไฟล์ — ตรวจว่าเป็นไฟล์ Invoice Report ของคลินิก"
      }, { status: 422 });
    }
    // Which detected tags already earn a fee (active rule), and at what rate.
    const rateByTag = new Map<string, number>();
    for (const r of activeRules(branchId)) for (const t of r.item_tags) if (!rateByTag.has(t)) rateByTag.set(t, r.rate);
    const detected = tags.map((t) => ({ ...t, currentRate: rateByTag.get(t.tag) ?? null }));
    return NextResponse.json({ ok: true, filename: file.name, totalRows, tags: detected });
  } catch (e) {
    return NextResponse.json({ error: "parse_failed", message: (e as Error).message }, { status: 422 });
  }
}
