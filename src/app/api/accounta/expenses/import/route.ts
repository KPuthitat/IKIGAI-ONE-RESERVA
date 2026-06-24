import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { splitVat, round2, type ExpenseInput } from "@/lib/accounta";
import { listBranches, listCompanies, createExpense } from "@/lib/accounta-db";

// POST /api/accounta/expenses/import — bulk-import expenses from a CSV.
// Accepts multipart (field "csv") OR a JSON body { csv }. Forgiving parse:
// resolves branch/company by name (contains), derives VAT from the total
// when has_tax_invoice is set, and reports per-row errors instead of
// failing the whole file. (owner 2026-06-17 — bulk-load historical data.)

const HEADERS = [
  "branch", "company", "bill_date", "vendor", "category", "description",
  "amount", "has_tax_invoice", "payment_status", "payment_method", "note"
] as const;

/** Minimal RFC-4180-ish CSV parser: quoted fields, escaped quotes, CRLF,
 *  leading BOM. Returns rows of string cells. */
function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch === "\r") { /* skip */ }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const truthy = (v: string) => /^(1|true|yes|y|ใช่|มี)$/i.test(v.trim());

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");

  let csv = "";
  const ctype = req.headers.get("content-type") || "";
  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const f = form?.get("csv");
    if (f instanceof File) csv = await f.text();
  } else {
    const j = await req.json().catch(() => ({})) as { csv?: string };
    csv = j.csv ?? "";
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

  let imported = 0;
  const errors: Array<{ row: number; message: string }> = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const dateRaw = get(r, "bill_date");
    const amount = Number(get(r, "amount").replace(/,/g, ""));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) { errors.push({ row: i + 1, message: "bill_date ต้องเป็น YYYY-MM-DD" }); continue; }
    if (!Number.isFinite(amount) || amount <= 0) { errors.push({ row: i + 1, message: "amount ไม่ถูกต้อง" }); continue; }

    const hasTax = truthy(get(r, "has_tax_invoice"));
    const status = /unpaid|ค้าง|รอ/i.test(get(r, "payment_status")) ? "unpaid" : "paid";
    const vat = splitVat(round2(amount), hasTax);
    const input: ExpenseInput = {
      branch_id: matchId(branches, get(r, "branch")),
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
    try { createExpense(user.id, input); imported++; }
    catch { errors.push({ row: i + 1, message: "บันทึกไม่สำเร็จ" }); }
  }

  return NextResponse.json({ ok: true, imported, failed: errors.length, errors: errors.slice(0, 50) });
}
