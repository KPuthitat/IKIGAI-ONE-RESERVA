import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { splitVat, round2, type ExpenseInput } from "@/lib/accounta";
import { listBranches, listCompanies, createExpense } from "@/lib/accounta-db";
import { parseCsv, truthy, normDate } from "@/lib/csv-import";

// POST /api/accounta/expenses/import — bulk-import expenses from a CSV.
// Accepts multipart (field "csv") OR a JSON body { csv }. Forgiving parse:
// resolves branch/company by name (contains), derives VAT from the total
// when has_tax_invoice is set, and reports per-row errors instead of
// failing the whole file. (owner 2026-06-17 — bulk-load historical data.)
// dry_run=1 returns a preview without writing (owner 2026-06-27).

const HEADERS = [
  "branch", "company", "bill_date", "vendor", "category", "description",
  "amount", "has_tax_invoice", "payment_status", "payment_method", "note"
] as const;

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");

  let csv = "";
  let dryRun = false;
  const ctype = req.headers.get("content-type") || "";
  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const f = form?.get("csv");
    if (f instanceof File) csv = await f.text();
    dryRun = truthy(String(form?.get("dry_run") ?? ""));
  } else {
    const j = await req.json().catch(() => ({})) as { csv?: string; dry_run?: boolean };
    csv = j.csv ?? "";
    dryRun = !!j.dry_run;
  }
  if (!csv.trim()) return NextResponse.json({ error: "no_csv" }, { status: 400 });

  const rows = parseCsv(csv);
  if (rows.length < 2) return NextResponse.json({ error: "empty", message: "ไม่พบข้อมูล (ต้องมีหัวตาราง + อย่างน้อย 1 แถว)" }, { status: 400 });

  // Map the header row to column indices (order-independent).
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx: Record<string, number> = {};
  for (const key of HEADERS) idx[key] = head.indexOf(key);
  if (idx.bill_date < 0 || idx.amount < 0) {
    return NextResponse.json({ error: "bad_header", message: "ต้องมีคอลัมน์ bill_date และ amount เป็นอย่างน้อย" }, { status: 400 });
  }

  const branches = listBranches();
  const companies = listCompanies();
  const matchId = (list: Array<{ id: number; name: string }>, raw: string): number | null => {
    const v = raw.trim().toLowerCase();
    if (!v) return null;
    const exact = list.find((x) => x.name.toLowerCase() === v);
    if (exact) return exact.id;
    const partial = list.find((x) => x.name.toLowerCase().includes(v) || v.includes(x.name.toLowerCase()));
    return partial?.id ?? null;
  };
  const get = (r: string[], k: string) => (idx[k] >= 0 ? (r[idx[k]] ?? "").trim() : "");

  // Pass 1 — validate + build every row's ExpenseInput (no DB writes yet). Used
  // both for the dry-run preview and the real commit so they can never diverge.
  const errors: Array<{ row: number; message: string }> = [];
  const ready: Array<{ input: ExpenseInput; branchRaw: string }> = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const dateRaw = normDate(get(r, "bill_date"));
    const amount = Number(get(r, "amount").replace(/,/g, ""));
    if (!dateRaw) { errors.push({ row: i + 1, message: "bill_date ต้องเป็น YYYY-MM-DD หรือ DD/MM/YYYY" }); continue; }
    if (!Number.isFinite(amount) || amount <= 0) { errors.push({ row: i + 1, message: "amount ไม่ถูกต้อง" }); continue; }

    const hasTax = truthy(get(r, "has_tax_invoice"));
    const status = /unpaid|ค้าง|รอ/i.test(get(r, "payment_status")) ? "unpaid" : "paid";
    const vat = splitVat(round2(amount), hasTax);
    const branchRaw = get(r, "branch");
    const input: ExpenseInput = {
      branch_id: matchId(branches, branchRaw),
      company_id: matchId(companies, get(r, "company")),
      bill_date: dateRaw,
      vendor_id: null,
      vendor_name: get(r, "vendor") || null,
      doc_type: null,
      category: get(r, "category") || null,
      description: get(r, "description") || null,
      amount_total: round2(amount),
      has_tax_invoice: hasTax,
      vat_amount: vat.vat,
      base_amount: vat.base,
      payment_status: status,
      payment_method: status === "paid" ? (get(r, "payment_method") || null) : null,
      paid_date: status === "paid" ? dateRaw : null,
      due_date: null,
      note: get(r, "note") || null
    };
    ready.push({ input, branchRaw });
  }

  // Dry run — return a preview so the owner can eyeball it before committing
  // (import has no undo; owner 2026-06-27). Summarise without touching the DB.
  if (dryRun) {
    const byCat = new Map<string, { count: number; amount: number }>();
    let total = 0; let unresolvedBranch = 0;
    const dates: string[] = [];
    for (const { input, branchRaw } of ready) {
      total += input.amount_total;
      dates.push(input.bill_date);
      if (branchRaw && input.branch_id == null) unresolvedBranch++;
      const k = input.category || "— ไม่ระบุหมวด —";
      const c = byCat.get(k) ?? { count: 0, amount: 0 };
      c.count++; c.amount += input.amount_total; byCat.set(k, c);
    }
    dates.sort();
    const sample = ready.slice(0, 8).map(({ input }) => ({
      bill_date: input.bill_date, vendor: input.vendor_name, category: input.category,
      amount: input.amount_total, payment_status: input.payment_status
    }));
    return NextResponse.json({
      ok: true, dryRun: true,
      willImport: ready.length,
      total: round2(total),
      failed: errors.length,
      unresolvedBranch,
      dateFrom: dates[0] ?? null,
      dateTo: dates[dates.length - 1] ?? null,
      byCategory: [...byCat.entries()].map(([name, v]) => ({ name, count: v.count, amount: round2(v.amount) }))
        .sort((a, b) => b.amount - a.amount),
      sample,
      errors: errors.slice(0, 50)
    });
  }

  // Commit.
  let imported = 0;
  for (const { input } of ready) {
    try { createExpense(user.id, input); imported++; }
    catch { errors.push({ row: 0, message: "บันทึกไม่สำเร็จ" }); }
  }
  return NextResponse.json({ ok: true, imported, failed: errors.length, errors: errors.slice(0, 50) });
}
