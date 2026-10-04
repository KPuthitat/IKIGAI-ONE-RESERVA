import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { filenameWindow, parseClinicaFile, type ClinicaFileParse } from "@/lib/clinica-parse";
import { importInvoice, importOpd, importOutstanding, importReceipt, type ClinicaImportResult } from "@/lib/clinica-db";
import { autopostClinicaIfEnabled } from "@/lib/clinica-accounta";

// CLINICA import — a reporta.manage user uploads the AT HOME CLINIC HIS exports
// (Invoice, Receipt, OPD reports, plus the outstanding-only Invoice snapshot).
// Each file carries its own date range; importing REPLACES that range for the
// active branch, so any window (a day, a month, a re-export) overwrites cleanly.
// The outstanding snapshot is the exception: it never deletes (see importOutstanding).
// Owner 2026-09-26; receipts + outstanding snapshot 2026-10-04.

export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 30 * 1024 * 1024;

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
    // A whole year of Invoice lines is ~14MB; parsing it takes ~2s / ~250MB.
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "file_too_large", message: `ไฟล์ใหญ่เกิน ${MAX_FILE_BYTES / 1024 / 1024}MB: ${file.name}` }, { status: 400 });
    }
    try {
      parsed.push({ name: file.name, p: parseClinicaFile(Buffer.from(await file.arrayBuffer())) });
    } catch (e) {
      return NextResponse.json({ error: "parse_failed", message: `${file.name}: ${(e as Error).message}` }, { status: 422 });
    }
  }

  // One file per kind per upload: two invoice files with overlapping ranges would
  // let the second's range-replace wipe bills the first just inserted. Normal use
  // is one of each kind; import different periods one upload at a time.
  const KIND_LABEL = { invoice: "Invoice Report", outstanding: "รายงานใบแจ้งหนี้ค้างชำระ", receipt: "Receipt Report", opd: "OPD Report" } as const;
  for (const kind of ["invoice", "outstanding", "receipt", "opd"] as const) {
    if (parsed.filter((f) => f.p.kind === kind).length > 1) {
      return NextResponse.json({ error: "duplicate_kind", message: `อัปโหลด ${KIND_LABEL[kind]} ได้ทีละ 1 ไฟล์ (คนละช่วงให้ทยอยนำเข้า)` }, { status: 422 });
    }
  }
  // Invoice before the outstanding snapshot, so the snapshot compares against fresh bills.
  const ORDER = { invoice: 0, outstanding: 1, receipt: 2, opd: 3 } as const;
  parsed.sort((a, b) => ORDER[a.p.kind] - ORDER[b.p.kind]);

  // All files in ONE transaction — if any file fails, nothing is committed, so
  // the owner never ends up with the invoice replaced but the OPD half-missing.
  const results: Array<ClinicaImportResult & { filename: string }> = [];
  try {
    getDb().transaction(() => {
      for (const { name, p } of parsed) {
        const r = p.kind === "invoice" ? importInvoice(branchId, p)
          : p.kind === "outstanding" ? importOutstanding(branchId, p, { window: filenameWindow(name) })
          : p.kind === "receipt" ? importReceipt(branchId, p)
          : importOpd(branchId, p);
        results.push({ filename: name, ...r });
      }
    })();
  } catch (e) {
    return NextResponse.json({ error: "save_failed", message: `บันทึกไม่สำเร็จ: ${(e as Error).message}` }, { status: 422 });
  }

  // Branch switched to "post to ACCOUNTA from the files": rebuild the branch's rows.
  // The whole history, not just the file's span — a receipt or outstanding snapshot
  // also changes bills dated before its own range (it is cheap: a few thousand rows).
  // A failure here is reported (the import UI shows it) but never undoes the import.
  const accounta = results.some((r) => r.kind !== "opd")
    ? autopostClinicaIfEnabled(branchId, user.id)
    : { posted: null };

  return NextResponse.json({ ok: true, imported: results, accounta });
}
