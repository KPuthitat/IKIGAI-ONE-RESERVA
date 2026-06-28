import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/accounta";
import { listBranches, listCompanies, createIncome, type IncomeInput } from "@/lib/accounta-db";
import { parseCsv, truthy, normDate } from "@/lib/csv-import";

// POST /api/accounta/income/import — bulk-import รายรับ from a CSV (owner
// 2026-06-27: load historical income / financing inflows e.g. loans). Mirrors
// the expense importer: forgiving parse, branch/company matched by name,
// DD/MM/YYYY accepted, per-row errors, and a dry_run=1 preview before commit.

const HEADERS = ["branch", "company", "income_date", "channel", "amount", "note", "is_vat"] as const;

// is_vat column: default taxable (sales). Explicit "0"/"no"/"ไม่มี"/"ไม่" → not taxable.
const isVatCell = (v: string): boolean => !/^(0|false|no|n|ไม่มี|ไม่)$/i.test(v.trim());

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

  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx: Record<string, number> = {};
  for (const key of HEADERS) idx[key] = head.indexOf(key);
  if (idx.income_date < 0 || idx.amount < 0) {
    return NextResponse.json({ error: "bad_header", message: "ต้องมีคอลัมน์ income_date และ amount เป็นอย่างน้อย" }, { status: 400 });
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

  // Pass 1 — validate + build (shared by preview + commit).
  const errors: Array<{ row: number; message: string }> = [];
  const ready: Array<{ input: IncomeInput; branchRaw: string }> = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const dateRaw = normDate(get(r, "income_date"));
    const amount = Number(get(r, "amount").replace(/,/g, ""));
    if (!dateRaw) { errors.push({ row: i + 1, message: "income_date ต้องเป็น YYYY-MM-DD หรือ DD/MM/YYYY" }); continue; }
    if (!Number.isFinite(amount) || amount <= 0) { errors.push({ row: i + 1, message: "amount ไม่ถูกต้อง" }); continue; }
    const branchRaw = get(r, "branch");
    ready.push({
      branchRaw,
      input: {
        branch_id: matchId(branches, branchRaw),
        company_id: matchId(companies, get(r, "company")),
        income_date: dateRaw,
        channel: get(r, "channel") || null,
        amount: round2(amount),
        note: get(r, "note") || null,
        is_vat: idx.is_vat >= 0 ? isVatCell(get(r, "is_vat")) : true
      }
    });
  }

  if (dryRun) {
    const byChan = new Map<string, { count: number; amount: number }>();
    let total = 0; let unresolvedBranch = 0;
    const dates: string[] = [];
    for (const { input, branchRaw } of ready) {
      total += input.amount;
      dates.push(input.income_date);
      if (branchRaw && input.branch_id == null) unresolvedBranch++;
      const k = input.channel || "— ไม่ระบุช่องทาง —";
      const c = byChan.get(k) ?? { count: 0, amount: 0 };
      c.count++; c.amount += input.amount; byChan.set(k, c);
    }
    dates.sort();
    const sample = ready.slice(0, 8).map(({ input }) => ({
      income_date: input.income_date, channel: input.channel, amount: input.amount, note: input.note
    }));
    return NextResponse.json({
      ok: true, dryRun: true,
      willImport: ready.length,
      total: round2(total),
      failed: errors.length,
      unresolvedBranch,
      dateFrom: dates[0] ?? null,
      dateTo: dates[dates.length - 1] ?? null,
      byCategory: [...byChan.entries()].map(([name, v]) => ({ name, count: v.count, amount: round2(v.amount) }))
        .sort((a, b) => b.amount - a.amount),
      sample,
      errors: errors.slice(0, 50)
    });
  }

  let imported = 0;
  for (const { input } of ready) {
    try { createIncome(user.id, input); imported++; }
    catch { errors.push({ row: 0, message: "บันทึกไม่สำเร็จ" }); }
  }
  return NextResponse.json({ ok: true, imported, failed: errors.length, errors: errors.slice(0, 50) });
}
