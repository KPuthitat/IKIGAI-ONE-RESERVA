import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { parseClinicaFile, type ClinicaFileParse } from "@/lib/clinica-parse";
import { importInvoice, importOpd, type ClinicaImportResult } from "@/lib/clinica-db";

// CLINICA import — a reporta.manage user uploads the AT HOME CLINIC HIS exports
// (Invoice Report and/or OPD Report). Each file carries its own date range;
// importing REPLACES that range for the active branch, so any window (a day, a
// month, a re-export) overwrites cleanly. Owner 2026-09-26.

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_branch" }, { status: 403 });

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "bad_form" }, { status: 400 }); }

  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (!files.length) return NextResponse.json({ error: "no_file" }, { status: 400 });

  // Parse + validate everything before writing anything.
  const parsed: Array<{ name: string; p: ClinicaFileParse }> = [];
  for (const file of files) {
    if (file.size > 12 * 1024 * 1024) {
      return NextResponse.json({ error: "file_too_large", message: `ไฟล์ใหญ่เกิน 12MB: ${file.name}` }, { status: 400 });
    }
    try {
      parsed.push({ name: file.name, p: parseClinicaFile(Buffer.from(await file.arrayBuffer())) });
    } catch (e) {
      return NextResponse.json({ error: "parse_failed", message: `${file.name}: ${(e as Error).message}` }, { status: 422 });
    }
  }

  // One file per kind per upload: two invoice files with overlapping ranges would
  // let the second's range-replace wipe bills the first just inserted. Normal use
  // is one Invoice + one OPD; import different periods one upload at a time.
  for (const kind of ["invoice", "opd"] as const) {
    if (parsed.filter((f) => f.p.kind === kind).length > 1) {
      return NextResponse.json({
        error: "duplicate_kind",
        message: kind === "invoice" ? "อัปโหลด Invoice Report ได้ทีละ 1 ไฟล์ (คนละช่วงให้ทยอยนำเข้า)" : "อัปโหลด OPD Report ได้ทีละ 1 ไฟล์"
      }, { status: 422 });
    }
  }

  // All files in ONE transaction — if any file fails, nothing is committed, so
  // the owner never ends up with the invoice replaced but the OPD half-missing.
  const results: Array<ClinicaImportResult & { filename: string }> = [];
  try {
    getDb().transaction(() => {
      for (const { name, p } of parsed) {
        const r = p.kind === "invoice" ? importInvoice(branchId, p) : importOpd(branchId, p);
        results.push({ filename: name, ...r });
      }
    })();
  } catch (e) {
    return NextResponse.json({ error: "save_failed", message: `บันทึกไม่สำเร็จ: ${(e as Error).message}` }, { status: 422 });
  }

  return NextResponse.json({ ok: true, imported: results });
}
