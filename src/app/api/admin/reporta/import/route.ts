import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isSalesaBranch, upsertDaily, upsertMenu, upsertReceipts, getMerchantName, existingKinds } from "@/lib/salesa-db";
import { parseSalesFile, type SalesFileParse } from "@/lib/salesa-parse";
import { getDb } from "@/lib/db";

// REPORTA import — staff (admin / หัวหน้างาน with reporta.manage) upload the POS
// "Close up" (ยอดขาย) and/or "Overview" (เมนู) .xlsx exports. Each file is
// sniffed + parsed + saved under the active branch, keyed by the file's own
// report date. One or several files per request. Owner 2026-09-16.
//
// Wrong-branch guard (owner 2026-09-17): each file carries a POS "Merchant"
// name that equals the outlet/branch (e.g. "NAMA PASTA SRIRACHA"). The file's
// merchant must match the ACTIVE BRANCH — by the branch's display name, or an
// explicit override in settings when the POS name differs. A file exported for
// a different shop is REJECTED and nothing is saved. (No auto-learn: an early
// mistake must not "teach" the branch the wrong shop.)

export const dynamic = "force-dynamic";

const norm = (s: string | null) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
/** Lenient equality: exact after normalisation, or one contains the other
 *  (handles a POS name that carries an extra suffix/prefix). */
function matches(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

export async function POST(req: Request) {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isSalesaBranch(branchId)) {
    return NextResponse.json({ error: "no_branch" }, { status: 403 });
  }
  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "bad_form" }, { status: 400 }); }

  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (!files.length) return NextResponse.json({ error: "no_file" }, { status: 400 });

  // Pass 1: parse + validate everything before saving anything.
  const parsedFiles: Array<{ name: string; parsed: SalesFileParse; merchant: string | null }> = [];
  for (const file of files) {
    if (file.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: "file_too_large", message: `ไฟล์ใหญ่เกิน 8MB: ${file.name}` }, { status: 400 });
    }
    let parsed: SalesFileParse;
    try {
      parsed = parseSalesFile(Buffer.from(await file.arrayBuffer()));
    } catch (e) {
      return NextResponse.json({ error: "parse_failed", message: `${file.name}: ${(e as Error).message}` }, { status: 422 });
    }
    const merchant = parsed.kind === "close_up" ? parsed.closeUp.merchant : parsed.kind === "overview" ? parsed.overview.merchant : parsed.receipt.merchant;
    parsedFiles.push({ name: file.name, parsed, merchant });
  }

  // Merchant guard. Expected = an explicit settings override, else the branch's
  // own display name. The file's POS merchant must match it.
  const branchName = (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined)?.name ?? `สาขา #${branchId}`;
  const expected = getMerchantName(branchId) ?? branchName;
  const bad = parsedFiles.find((f) => f.merchant && !matches(f.merchant, expected));
  if (bad) {
    return NextResponse.json({
      error: "merchant_mismatch",
      message: "ไฟล์ที่นำเข้าไม่ตรงกับสาขาที่ใช้งานอยู่"
    }, { status: 422 });
  }

  // Pass 2: save. `overwritten` = this (date, kind) already held data before
  // this import, so the importer is warned it replaced existing data.
  const results: Array<{ filename: string; kind: string; date: string; merchant: string | null; note: string; overwritten: boolean }> = [];
  for (const f of parsedFiles) {
    if (f.parsed.kind === "close_up") {
      const c = f.parsed.closeUp;
      const overwritten = existingKinds(branchId, c.date).sales;
      upsertDaily(branchId, user.id, c);
      results.push({ filename: f.name, kind: "close_up", date: c.date, merchant: c.merchant, note: `ยอดสุทธิ ${c.nett.toLocaleString("th-TH")} · ${c.billCount} บิล`, overwritten });
    } else if (f.parsed.kind === "overview") {
      const o = f.parsed.overview;
      const overwritten = existingKinds(branchId, o.date).menu;
      upsertMenu(branchId, user.id, o);
      results.push({ filename: f.name, kind: "overview", date: o.date, merchant: o.merchant, note: `เมนู ${o.items.length} รายการ · หมวด ${o.categories.length}`, overwritten });
    } else {
      const rc = f.parsed.receipt;
      const overwritten = existingKinds(branchId, rc.date).receipt;
      upsertReceipts(branchId, user.id, rc);
      const staff = rc.bills.filter((b) => b.isStaff).length;
      results.push({ filename: f.name, kind: "receipt", date: rc.date, merchant: rc.merchant, note: `ใบเสร็จ ${rc.bills.length} บิล${staff ? ` (พนักงาน ${staff})` : ""}`, overwritten });
    }
  }

  return NextResponse.json({ ok: true, imported: results });
}
