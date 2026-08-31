// Doctor Fee (DF) — server data layer. Clinic-only. A doctor's fee = rate% of
// the clinic's service revenue (HSC/HSC-GRP …) on the days they're on the
// roster; days are split equally when more than one doctor is rostered. Owner
// 2026-08. Rules bundle the earning item-tags at one rate and are extensible
// (procedure groups later). Everything is branch-scoped.

import { getDb } from "./db";
import type { DfParsedLine } from "./df-invoice-parse";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function key(invoiceNo: string, tag: string): string {
  return invoiceNo + " " + tag;
}

export function isDfBranch(branchId: number): boolean {
  const row = getDb().prepare("SELECT df_enabled FROM branches WHERE id = ?")
    .get(branchId) as { df_enabled: number } | undefined;
  return !!row && row.df_enabled === 1;
}

// ── Rules ─────────────────────────────────────────────────────────

export type DfRule = {
  id: number; branch_id: number; name: string;
  item_tags: string[]; rate: number; active: boolean; sort_order: number;
};

type DfRuleRow = Omit<DfRule, "item_tags" | "active"> & { item_tags: string; active: number };

function mapRule(r: DfRuleRow): DfRule {
  let tags: string[] = [];
  try { const p = JSON.parse(r.item_tags); if (Array.isArray(p)) tags = p.map((x) => String(x)); } catch { /* keep [] */ }
  return { id: r.id, branch_id: r.branch_id, name: r.name, item_tags: tags, rate: r.rate, active: r.active === 1, sort_order: r.sort_order };
}

function normTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toUpperCase()).filter(Boolean))];
}

export function listRules(branchId: number): DfRule[] {
  const rows = getDb().prepare(
    "SELECT * FROM df_fee_rules WHERE branch_id = ? ORDER BY sort_order, id"
  ).all(branchId) as DfRuleRow[];
  return rows.map(mapRule);
}

export function activeRules(branchId: number): DfRule[] {
  return listRules(branchId).filter((r) => r.active);
}

export type UpsertRuleInput = { name: string; item_tags: string[]; rate: number; active: boolean };

export function createRule(branchId: number, input: UpsertRuleInput): DfRule {
  const db = getDb();
  const maxSort = (db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM df_fee_rules WHERE branch_id = ?")
    .get(branchId) as { m: number }).m;
  const info = db.prepare(
    `INSERT INTO df_fee_rules (branch_id, name, item_tags, rate, active, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(branchId, input.name.trim(), JSON.stringify(normTags(input.item_tags)), input.rate, input.active ? 1 : 0, maxSort + 1);
  return mapRule(db.prepare("SELECT * FROM df_fee_rules WHERE id = ?").get(info.lastInsertRowid) as DfRuleRow);
}

export function updateRule(id: number, branchId: number, patch: Partial<UpsertRuleInput>): DfRule | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM df_fee_rules WHERE id = ? AND branch_id = ?").get(id, branchId) as DfRuleRow | undefined;
  if (!existing) return null;
  const fields: string[] = []; const vals: Array<string | number> = [];
  if (patch.name !== undefined) { fields.push("name = ?"); vals.push(patch.name.trim()); }
  if (patch.item_tags !== undefined) { fields.push("item_tags = ?"); vals.push(JSON.stringify(normTags(patch.item_tags))); }
  if (patch.rate !== undefined) { fields.push("rate = ?"); vals.push(patch.rate); }
  if (patch.active !== undefined) { fields.push("active = ?"); vals.push(patch.active ? 1 : 0); }
  if (fields.length === 0) return mapRule(existing);
  fields.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(id, branchId);
  db.prepare(`UPDATE df_fee_rules SET ${fields.join(", ")} WHERE id = ? AND branch_id = ?`).run(...vals);
  return mapRule(db.prepare("SELECT * FROM df_fee_rules WHERE id = ?").get(id) as DfRuleRow);
}

export function deleteRule(id: number, branchId: number): boolean {
  return getDb().prepare("DELETE FROM df_fee_rules WHERE id = ? AND branch_id = ?").run(id, branchId).changes > 0;
}

/** All item-tags earned by any ACTIVE rule (drives what the import keeps). */
export function wantedTags(branchId: number): string[] {
  return normTags(activeRules(branchId).flatMap((r) => r.item_tags));
}

// ── Invoice lines (imported) ──────────────────────────────────────

export type ImportSummary = { inserted: number; updated: number; total: number; periodStart: string | null; periodEnd: string | null };

// Idempotent upsert on (branch_id, invoice_no, item_tag). Re-importing the same
// month overwrites the matched lines rather than duplicating them.
export function importInvoiceLines(branchId: number, lines: DfParsedLine[], sourceFile: string): ImportSummary {
  const db = getDb();
  const up = db.prepare(
    `INSERT INTO df_invoice_lines
       (branch_id, invoice_no, line_date, item_code, item_tag, description, qty, gross, discount, net, source_file)
     VALUES (@branch_id, @invoice_no, @line_date, @item_code, @item_tag, @description, @qty, @gross, @discount, @net, @source_file)
     ON CONFLICT (branch_id, invoice_no, item_tag) DO UPDATE SET
       line_date=excluded.line_date, item_code=excluded.item_code, description=excluded.description,
       qty=excluded.qty, gross=excluded.gross, discount=excluded.discount, net=excluded.net,
       source_file=excluded.source_file, imported_at=CURRENT_TIMESTAMP`
  );
  // Classify insert vs update up front (INSERT…ON CONFLICT can't report which),
  // then upsert in one transaction.
  const existsStmt = db.prepare(
    "SELECT 1 FROM df_invoice_lines WHERE branch_id = ? AND invoice_no = ? AND item_tag = ?"
  );
  const existedBefore = new Set<string>();
  for (const l of lines) {
    if (existsStmt.get(branchId, l.invoiceNo, l.tag)) existedBefore.add(key(l.invoiceNo, l.tag));
  }
  const tx = db.transaction((rows: DfParsedLine[]) => {
    for (const l of rows) {
      up.run({
        branch_id: branchId, invoice_no: l.invoiceNo, line_date: l.lineDate,
        item_code: l.itemCode || null, item_tag: l.tag, description: l.description,
        qty: l.qty, gross: l.gross, discount: l.discount, net: l.net, source_file: sourceFile
      });
    }
  });
  tx(lines);
  let inserted = 0, updated = 0;
  for (const l of lines) {
    if (existedBefore.has(key(l.invoiceNo, l.tag))) updated++; else inserted++;
  }
  const dates = lines.map((l) => l.lineDate).sort();
  return { inserted, updated, total: lines.length, periodStart: dates[0] ?? null, periodEnd: dates[dates.length - 1] ?? null };
}

export type DfInvoiceLine = {
  id: number; invoice_no: string; line_date: string; item_code: string | null;
  item_tag: string; description: string | null; qty: number; gross: number; discount: number; net: number;
};

export function linesInRange(branchId: number, start: string, end: string): DfInvoiceLine[] {
  return getDb().prepare(
    `SELECT id, invoice_no, line_date, item_code, item_tag, description, qty, gross, discount, net
     FROM df_invoice_lines WHERE branch_id = ? AND line_date >= ? AND line_date <= ?
     ORDER BY line_date, invoice_no`
  ).all(branchId, start, end) as DfInvoiceLine[];
}

/** The imported date span for a branch (for defaulting the period picker). */
export function importedSpan(branchId: number): { min: string | null; max: string | null; count: number } {
  return getDb().prepare(
    "SELECT MIN(line_date) AS min, MAX(line_date) AS max, COUNT(*) AS count FROM df_invoice_lines WHERE branch_id = ?"
  ).get(branchId) as { min: string | null; max: string | null; count: number };
}

// ── Compute (roster × doctor attribution) ─────────────────────────

export type DfDoctorDay = { date: string; dayPool: number; dayFee: number; share: number; doctorCount: number };
export type DfDoctorResult = {
  user_id: number; display_name: string; title_prefix: string | null;
  days: DfDoctorDay[]; totalFee: number; workedDays: number;
};
export type DfRulePool = { id: number; name: string; rate: number; tags: string[]; pool: number; fee: number };
export type DfComputeResult = {
  periodStart: string; periodEnd: string;
  totalPool: number; totalFee: number; assignedFee: number; unassignedFee: number;
  rules: DfRulePool[];
  doctors: DfDoctorResult[];
  unassignedDays: Array<{ date: string; pool: number; fee: number }>;
  hasRoster: boolean;
};

export type DfDoctor = { user_id: number; display_name: string; title_prefix: string | null };

// Users eligible to earn a DF: clinic doctors, or already on the DF comp type
// (phase 2). Active only.
export function eligibleDoctors(): DfDoctor[] {
  return getDb().prepare(
    `SELECT id AS user_id, display_name, title_prefix FROM users
     WHERE (clinical_role = 'doctor' OR employment_type = 'df')
       AND status NOT IN ('disabled','resigned','terminated')
     ORDER BY display_name`
  ).all() as DfDoctor[];
}

// date → [doctor user_ids] rostered that date on this branch (work shifts only).
function doctorsByDate(branchId: number, start: string, end: string): Map<string, number[]> {
  const rows = getDb().prepare(
    `SELECT DISTINCT ra.assignment_date AS d, ra.user_id AS uid
     FROM roster_assignments ra
     JOIN shift_codes sc ON sc.id = ra.shift_code_id
     WHERE ra.branch_id = ? AND ra.assignment_date >= ? AND ra.assignment_date <= ?
       AND sc.kind = 'work'
       AND ra.user_id IN (
         SELECT id FROM users
         WHERE (clinical_role = 'doctor' OR employment_type = 'df')
           AND status NOT IN ('disabled','resigned','terminated'))`
  ).all(branchId, start, end) as Array<{ d: string; uid: number }>;
  const m = new Map<string, number[]>();
  for (const r of rows) {
    const a = m.get(r.d) ?? [];
    a.push(r.uid);
    m.set(r.d, a);
  }
  return m;
}

export function computeDoctorFees(branchId: number, start: string, end: string): DfComputeResult {
  const db = getDb();
  const rules = activeRules(branchId);
  // tag → rate (a tag belongs to one rule; last wins on the rare overlap).
  const tagRate = new Map<string, number>();
  const ruleOfTag = new Map<string, number>();
  for (const r of rules) for (const t of r.item_tags) { tagRate.set(t, r.rate); ruleOfTag.set(t, r.id); }

  const lines = linesInRange(branchId, start, end);

  // Per-date fee + pool, and per-rule pool/fee for the breakdown.
  const dayFee = new Map<string, number>();
  const dayPool = new Map<string, number>();
  const rulePool = new Map<number, { pool: number; fee: number }>();
  for (const r of rules) rulePool.set(r.id, { pool: 0, fee: 0 });
  let totalPool = 0, totalFee = 0;
  for (const l of lines) {
    const rate = tagRate.get(l.item_tag);
    if (rate === undefined) continue;         // tag not earning under any active rule
    const fee = l.net * rate;
    dayFee.set(l.line_date, (dayFee.get(l.line_date) ?? 0) + fee);
    dayPool.set(l.line_date, (dayPool.get(l.line_date) ?? 0) + l.net);
    totalPool += l.net; totalFee += fee;
    const rp = rulePool.get(ruleOfTag.get(l.item_tag)!)!;
    rp.pool += l.net; rp.fee += fee;
  }

  const docByDate = doctorsByDate(branchId, start, end);
  const hasRoster = docByDate.size > 0;

  // Attribute each day's fee to the rostered doctors (equal split).
  const perDoctor = new Map<number, DfDoctorDay[]>();
  const unassignedDays: Array<{ date: string; pool: number; fee: number }> = [];
  let assignedFee = 0, unassignedFee = 0;
  for (const [date, fee] of dayFee) {
    if (fee <= 0) continue;
    const docs = docByDate.get(date) ?? [];
    const pool = dayPool.get(date) ?? 0;
    if (docs.length === 0) {
      unassignedDays.push({ date, pool: round2(pool), fee: round2(fee) });
      unassignedFee += fee;
      continue;
    }
    const share = fee / docs.length;
    for (const uid of docs) {
      const arr = perDoctor.get(uid) ?? [];
      arr.push({ date, dayPool: round2(pool), dayFee: round2(fee), share: round2(share), doctorCount: docs.length });
      perDoctor.set(uid, arr);
    }
    assignedFee += fee;
  }

  // Resolve doctor names.
  const doctors: DfDoctorResult[] = [];
  if (perDoctor.size > 0) {
    const ids = [...perDoctor.keys()];
    const users = db.prepare(
      `SELECT id, display_name, title_prefix FROM users WHERE id IN (${ids.map(() => "?").join(",")})`
    ).all(...ids) as Array<{ id: number; display_name: string; title_prefix: string | null }>;
    const uMap = new Map(users.map((u) => [u.id, u]));
    for (const [uid, days] of perDoctor) {
      const u = uMap.get(uid);
      days.sort((a, b) => a.date.localeCompare(b.date));
      doctors.push({
        user_id: uid,
        display_name: u?.display_name ?? ("#" + uid),
        title_prefix: u?.title_prefix ?? null,
        days,
        totalFee: round2(days.reduce((s, d) => s + d.share, 0)),
        workedDays: days.length
      });
    }
    doctors.sort((a, b) => b.totalFee - a.totalFee);
  }

  unassignedDays.sort((a, b) => a.date.localeCompare(b.date));
  const rulesOut: DfRulePool[] = rules.map((r) => {
    const rp = rulePool.get(r.id)!;
    return { id: r.id, name: r.name, rate: r.rate, tags: r.item_tags, pool: round2(rp.pool), fee: round2(rp.fee) };
  });

  return {
    periodStart: start, periodEnd: end,
    totalPool: round2(totalPool), totalFee: round2(totalFee),
    assignedFee: round2(assignedFee), unassignedFee: round2(unassignedFee),
    rules: rulesOut, doctors, unassignedDays, hasRoster
  };
}
