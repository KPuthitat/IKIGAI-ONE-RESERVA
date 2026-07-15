// ── น้องฮูก (smart) — safe read-only data tools (server-only) ───────
//
// These are the ONLY ways the AI assistant can touch the database. The model
// never writes SQL; it picks one of these tools + parameters, we run a fixed
// parameterized query, and feed the numbers back. Every figure the owl quotes
// therefore comes from the DB, not the model (owner rule: ตัวเลขจริงต้องเป๊ะ).
//
// Scope: ACCOUNTA (การเงิน) + PERSONA (งานบุคคล). Admin-only at the route.

import { getDb } from "./db";
import { round2 } from "./accounta";
import { summarise, incomeSummary, daybook, listBranches, listCompanies, listCategories, listIncomeChannels, ocrUsageStats, finAnalysisUsageStats } from "./accounta-db";
import { owlAiCostBaht } from "./owl-ai-models";

export function bkkMonth(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

// ── Name → id resolution (fuzzy, like the CSV importer) ────────────

function matchId(list: Array<{ id: number; name: string }>, raw?: string | null): number | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  const exact = list.find((x) => x.name.toLowerCase() === v);
  if (exact) return exact.id;
  const partial = list.find(
    (x) => x.name.toLowerCase().includes(v) || v.includes(x.name.toLowerCase())
  );
  return partial?.id ?? null;
}

function resolveBranchId(name?: string | null): number | null {
  return matchId(listBranches(), name);
}
function resolveCompanyId(name?: string | null): number | null {
  return matchId(listCompanies(), name);
}

// ── Reference lists — so the model knows valid filter values + "now" ──

export function referenceLists() {
  return {
    currentMonth: bkkMonth(),
    today: new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10),
    branches: listBranches().map((b) => b.name),
    companies: listCompanies().map((c) => c.name),
    expenseCategories: listCategories().map((c) => c.name),
    incomeChannels: listIncomeChannels().map((c) => c.name)
  };
}

// ── ACCOUNTA: expenses ─────────────────────────────────────────────

export function expenseSummary(a: {
  month?: string; branch_name?: string; company_name?: string;
  by_category?: boolean; by_vendor?: boolean;
}) {
  const month = a.month || bkkMonth();
  const branchId = resolveBranchId(a.branch_name);
  const companyId = resolveCompanyId(a.company_name);
  const s = summarise(month, branchId, companyId);

  const db = getDb();
  const where = ["review_status = 'confirmed'", "substr(bill_date,1,7) = ?"];
  const args: Array<string | number> = [month];
  if (branchId != null) { where.push("branch_id = ?"); args.push(branchId); }
  if (companyId != null) { where.push("company_id = ?"); args.push(companyId); }
  const w = where.join(" AND ");

  const out: Record<string, unknown> = {
    month,
    scope: { branch: a.branch_name ?? "ทุกสาขา", company: a.company_name ?? "ทุกบริษัท" },
    byBill_total: s.accrual.total,        // ตามบิล (accrual)
    base: s.accrual.base,
    inputVat: s.inputVat,                 // ภาษีซื้อ
    billCount: s.accrual.count,
    cashOut_thisMonth: s.cash.total,      // กระแสเงินสดที่จ่ายจริงเดือนนี้
    unpaidOutstanding: s.unpaidTotal,
    unpaidCount: s.unpaidCount
  };
  if (a.by_category) {
    out.byCategory = db.prepare(
      `SELECT COALESCE(category,'(ไม่ระบุ)') AS name, ROUND(SUM(amount_total),2) AS total, COUNT(*) AS count
         FROM accounta_expenses WHERE ${w} GROUP BY COALESCE(category,'(ไม่ระบุ)') ORDER BY total DESC`
    ).all(...args);
  }
  if (a.by_vendor) {
    out.topVendors = db.prepare(
      `SELECT COALESCE(vendor_name,'(ไม่ระบุ)') AS name, ROUND(SUM(amount_total),2) AS total, COUNT(*) AS count
         FROM accounta_expenses WHERE ${w} GROUP BY COALESCE(vendor_name,'(ไม่ระบุ)') ORDER BY total DESC LIMIT 10`
    ).all(...args);
  }
  return out;
}

export function unpaidBills(a: { branch_name?: string; company_name?: string }) {
  const db = getDb();
  const branchId = resolveBranchId(a.branch_name);
  const companyId = resolveCompanyId(a.company_name);
  const where = ["e.review_status = 'confirmed'", "e.payment_status = 'unpaid'"];
  const args: Array<string | number> = [];
  if (branchId != null) { where.push("e.branch_id = ?"); args.push(branchId); }
  if (companyId != null) { where.push("e.company_id = ?"); args.push(companyId); }
  const rows = db.prepare(
    `SELECT e.bill_date, COALESCE(e.vendor_name,'(ไม่ระบุ)') AS vendor,
            COALESCE(e.category,'(ไม่ระบุ)') AS category, e.amount_total AS amount,
            b.name AS branch
       FROM accounta_expenses e LEFT JOIN branches b ON b.id = e.branch_id
      WHERE ${where.join(" AND ")} ORDER BY e.bill_date ASC LIMIT 50`
  ).all(...args) as Array<Record<string, unknown>>;
  const total = round2(rows.reduce((s, r) => s + Number(r.amount || 0), 0));
  return { count: rows.length, total, bills: rows };
}

// ── ACCOUNTA: income + daybook ─────────────────────────────────────

export function incomeSummaryTool(a: { month?: string; branch_name?: string; company_name?: string }) {
  const month = a.month || bkkMonth();
  const branchId = resolveBranchId(a.branch_name);
  const companyId = resolveCompanyId(a.company_name);
  const s = incomeSummary(month, branchId, companyId);
  return {
    month,
    scope: { branch: a.branch_name ?? "ทุกสาขา", company: a.company_name ?? "ทุกบริษัท" },
    total: s.total,
    byChannel: s.byChannel
  };
}

export function daybookSummary(a: { month?: string; branch_name?: string; company_name?: string }) {
  const month = a.month || bkkMonth();
  const branchId = resolveBranchId(a.branch_name);
  const companyId = resolveCompanyId(a.company_name);
  const d = daybook(month, branchId, companyId);
  const topSpendDays = [...d.days]
    .sort((x, y) => y.expenseTotal - x.expenseTotal)
    .slice(0, 5)
    .map((x) => ({ date: x.date, expense: x.expenseTotal, income: x.income }));
  return {
    month,
    scope: { branch: a.branch_name ?? "ทุกสาขา", company: a.company_name ?? "ทุกบริษัท" },
    totalIncome: d.totalIncome,
    totalExpense: d.totalExpense,
    net: d.net,
    daysWithActivity: d.days.length,
    topSpendDays
  };
}

// ── PERSONA: leave / headcount / pending requests ──────────────────

const LEAVE_LABEL: Record<string, string> = {
  sick: "ลาป่วย", personal: "ลากิจส่วนตัว", annual: "ลาพักร้อน",
  pt_emergency: "ลาฉุกเฉิน (พาร์ทไทม์)", maternity: "ลาคลอด",
  ordination: "ลาบวช", sterilization: "ลาทำหมัน", military: "ลารับราชการทหาร",
  unpaid: "ลาไม่รับค่าจ้าง"
};

export function leaveSummary(a: { month?: string; branch_name?: string; status?: string }) {
  const db = getDb();
  const month = a.month || bkkMonth();
  const branchId = resolveBranchId(a.branch_name);
  const status = ["pending", "approved", "rejected", "cancelled"].includes(a.status ?? "")
    ? a.status : null;
  const where = ["substr(l.date_from,1,7) = ?"];
  const args: Array<string | number> = [month];
  if (branchId != null) { where.push("l.branch_id = ?"); args.push(branchId); }
  if (status) { where.push("l.status = ?"); args.push(status); }
  const rows = db.prepare(
    `SELECT l.type, l.status, COUNT(*) AS count, ROUND(COALESCE(SUM(l.days),0),2) AS days
       FROM leave_requests l WHERE ${where.join(" AND ")}
      GROUP BY l.type, l.status ORDER BY count DESC`
  ).all(...args) as Array<{ type: string; status: string; count: number; days: number }>;
  return {
    month,
    scope: { branch: a.branch_name ?? "ทุกสาขา", status: status ?? "ทุกสถานะ" },
    breakdown: rows.map((r) => ({
      type: LEAVE_LABEL[r.type] ?? r.type, status: r.status, count: r.count, days: r.days
    })),
    totalRequests: rows.reduce((s, r) => s + r.count, 0),
    totalDays: round2(rows.reduce((s, r) => s + r.days, 0))
  };
}

export function staffHeadcount(a: { branch_name?: string }) {
  const db = getDb();
  const branchId = resolveBranchId(a.branch_name);
  // Admins are employees too; exclude disabled + resigned (CLAUDE.md rules).
  let n: number;
  if (branchId != null) {
    n = (db.prepare(
      `SELECT COUNT(DISTINCT u.id) AS n FROM users u
         JOIN user_branches ub ON ub.user_id = u.id
        WHERE ub.branch_id = ? AND u.role IN ('staff','admin')
          AND u.status NOT IN ('disabled','resigned','terminated')`
    ).get(branchId) as { n: number }).n;
  } else {
    n = (db.prepare(
      `SELECT COUNT(*) AS n FROM users
        WHERE role IN ('staff','admin') AND status NOT IN ('disabled','resigned','terminated')`
    ).get() as { n: number }).n;
  }
  return { scope: { branch: a.branch_name ?? "ทุกสาขา" }, activeStaff: n };
}

export function pendingRequests(a: { branch_name?: string }) {
  const db = getDb();
  const branchId = resolveBranchId(a.branch_name);
  // Table names are a fixed allowlist below — never user input — so the
  // interpolation is safe. Wrapped in try/catch so an old install missing a
  // table degrades to 0 rather than throwing.
  const countPending = (table: string): number => {
    try {
      if (branchId != null) {
        return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status='pending' AND branch_id=?`)
          .get(branchId) as { n: number }).n;
      }
      return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status='pending'`)
        .get() as { n: number }).n;
    } catch { return 0; }
  };
  return {
    scope: { branch: a.branch_name ?? "ทุกสาขา" },
    shiftChange: countPending("shift_change_requests"),
    leave: countPending("leave_requests"),
    ot: countPending("ot_requests")
  };
}

// ── Usage log (for the settings counter, mirrors accounta_ocr_usage) ──

export function logOwlUsage(d: {
  model: string; inputTokens: number; outputTokens: number;
  question: string; userId: number;
}): void {
  const cost = owlAiCostBaht(d.model, d.inputTokens, d.outputTokens);
  getDb().prepare(`
    INSERT INTO owl_ai_usage (model, input_tokens, output_tokens, cost_baht, question, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(d.model, d.inputTokens, d.outputTokens, cost, d.question.slice(0, 500), d.userId);
}

export function owlUsageStats(month: string): {
  monthCount: number; monthBaht: number; totalCount: number; totalBaht: number;
} {
  const db = getDb();
  const m = db.prepare(
    "SELECT COUNT(*) AS c, COALESCE(SUM(cost_baht),0) AS b FROM owl_ai_usage WHERE substr(created_at,1,7) = ?"
  ).get(month) as { c: number; b: number };
  const t = db.prepare(
    "SELECT COUNT(*) AS c, COALESCE(SUM(cost_baht),0) AS b FROM owl_ai_usage"
  ).get() as { c: number; b: number };
  return { monthCount: m.c, monthBaht: round2(m.b), totalCount: t.c, totalBaht: round2(t.b) };
}

/** Combined Claude API usage across EVERY action that calls it — bill OCR
 *  (in-app + LINE), น้องฮูก questions, and financial analysis (กูรูการเงิน) — so
 *  the owl can show one running spend figure (owner 2026-06-18). */
export function aiUsageSummary(month: string) {
  const ocr = ocrUsageStats(month);
  const owl = owlUsageStats(month);
  const fin = finAnalysisUsageStats(month);
  return {
    month,
    monthCount: ocr.monthCount + owl.monthCount + fin.monthCount,
    monthBaht: round2(ocr.monthBaht + owl.monthBaht + fin.monthBaht),
    totalCount: ocr.totalCount + owl.totalCount + fin.totalCount,
    totalBaht: round2(ocr.totalBaht + owl.totalBaht + fin.totalBaht),
    ocr: { monthCount: ocr.monthCount, monthBaht: ocr.monthBaht },
    owl: { monthCount: owl.monthCount, monthBaht: owl.monthBaht },
    fin: { monthCount: fin.monthCount, monthBaht: fin.monthBaht }
  };
}
