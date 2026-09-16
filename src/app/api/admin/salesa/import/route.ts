import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isSalesaBranch, upsertDaily, upsertMenu } from "@/lib/salesa-db";
import { parseSalesFile } from "@/lib/salesa-parse";

// SALESA import — staff (admin / หัวหน้างาน with salesa.manage) upload the POS
// "Close up" (ยอดขาย) and/or "Overview" (เมนู) .xlsx exports. Each file is
// sniffed + parsed + saved under the active branch, keyed by the file's own
// report date. One or several files per request. Owner 2026-09-16.

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = requirePermission("salesa.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isSalesaBranch(branchId)) {
    return NextResponse.json({ error: "no_branch" }, { status: 403 });
  }
  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "bad_form" }, { status: 400 }); }

  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (!files.length) return NextResponse.json({ error: "no_file" }, { status: 400 });

  const results: Array<{ filename: string; kind: string; date: string; merchant: string | null; note: string }> = [];
  for (const file of files) {
    if (file.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: "file_too_large", message: `ไฟล์ใหญ่เกิน 8MB: ${file.name}` }, { status: 400 });
    }
    let parsed;
    try {
      parsed = parseSalesFile(Buffer.from(await file.arrayBuffer()));
    } catch (e) {
      return NextResponse.json({ error: "parse_failed", message: `${file.name}: ${(e as Error).message}` }, { status: 422 });
    }
    if (parsed.kind === "close_up") {
      const c = parsed.closeUp;
      upsertDaily(branchId, user.id, c);
      results.push({ filename: file.name, kind: "close_up", date: c.date, merchant: c.merchant, note: `ยอดสุทธิ ${c.nett.toLocaleString("th-TH")} · ${c.billCount} บิล` });
    } else {
      const o = parsed.overview;
      upsertMenu(branchId, user.id, o);
      results.push({ filename: file.name, kind: "overview", date: o.date, merchant: o.merchant, note: `เมนู ${o.items.length} รายการ · หมวด ${o.categories.length}` });
    }
  }

  return NextResponse.json({ ok: true, imported: results });
}
