// One-off: copy a branch's checklist / readiness config to another branch.
//
// Owner 2026-07-25: set HYPOPLARAEMIA's defaults to match NAMA PASTA
// SRIRACHA for all four configurable lists:
//   • shift_open      — Check list ก่อนเริ่มงาน
//   • readiness_1130  — รายงานความพร้อมรอบเช้า
//   • readiness_1600  — รายงานความพร้อมรอบบ่าย
//   • shift_close     — Check list หลังเลิกงาน
//
// All four live in ONE table, shift_checklist_items, distinguished by
// `type` and scoped by `branch_id`. Rows can be 2-level nested via a
// self-referential parent_id (ON DELETE CASCADE) — so a flat copy would
// break child→parent links; this remaps parent ids on insert.
//
// The target already has auto-seeded defaults for shift_open + readiness
// (db.ts seeds any branch with zero rows of a type), so a naive append
// would duplicate. We DELETE the target's rows for each copied type first,
// making the whole run idempotent — re-running produces the same result.
//
// The shift_close card's three "headline money" fields (drawer / service
// charge / revenue: labels, order, red-box flag) do NOT live in
// shift_checklist_items — they're sc_* columns on the branches row. Copied
// too so the หลังเลิกงาน card matches (skip with --no-headline).
//
// Run on the VPS, from /var/www/reserva, with an explicit confirm flag:
//   node --import tsx scripts/copy-branch-checklists.ts --yes
//
// Without --yes it prints exactly what WOULD change and exits (dry run).
// Override the branches by name if needed:
//   node --import tsx scripts/copy-branch-checklists.ts \
//     --from "NAMA PASTA SRIRACHA" --to "HYPOPLARAEMIA" --yes

import type BetterSqlite3 from "better-sqlite3";
import { getDb } from "../src/lib/db";

export const CHECKLIST_TYPES = [
  "shift_open",
  "readiness_1130",
  "readiness_1600",
  "shift_close",
] as const;
export type ChecklistType = (typeof CHECKLIST_TYPES)[number];

// Every non-identity column of shift_checklist_items. `id` is autoincrement
// (remapped), `created_at` defaults to now — both deliberately excluded so
// copies get fresh identity/timestamps.
const COPY_COLS = [
  "type",
  "label",
  "display_order",
  "active",
  "kind",
  "options_json",
  "is_headline_amount",
  "description",
  "income_breakdown",
] as const;

// The shift_close "headline money" config on the branches row.
const SC_COLS = [
  "sc_show_drawer_primary",
  "sc_show_svc_primary",
  "sc_show_revenue_primary",
  "sc_drawer_label",
  "sc_svc_label",
  "sc_revenue_label",
  "sc_drawer_order",
  "sc_svc_order",
  "sc_revenue_order",
] as const;

type Row = Record<string, unknown> & { id: number; parent_id: number | null };

// Income channels drive the shift-close "ยอดขายแยกช่องทางการรับเงิน" breakdown,
// so they must be copied too or HYPO's close form won't match NAMA's.
const CHANNEL_COLS = ["name", "sort_order", "active", "show_on_close", "is_credit"] as const;

export interface CopySummary {
  perType: Record<ChecklistType, { deleted: number; inserted: number }>;
  headlineCopied: boolean;
  channels: { deleted: number; inserted: number } | null;
}

/**
 * Copy the four checklist/readiness lists (and, unless disabled, the
 * shift_close headline sc_* columns) from srcBranchId to dstBranchId.
 *
 * Idempotent: clears the destination's rows for each copied type before
 * re-inserting, so re-running converges. Parent→child links are preserved
 * by remapping parent_id to the newly-inserted parent's id. Caller wraps
 * in a transaction.
 */
export function copyBranchChecklists(
  db: BetterSqlite3.Database,
  srcBranchId: number,
  dstBranchId: number,
  opts: { types?: readonly ChecklistType[]; copyHeadline?: boolean; copyChannels?: boolean } = {}
): CopySummary {
  const types = opts.types ?? CHECKLIST_TYPES;
  const copyHeadline = opts.copyHeadline ?? true;
  const copyChannels = opts.copyChannels ?? true;

  const selRows = db.prepare(
    `SELECT * FROM shift_checklist_items
      WHERE branch_id = ? AND type = ?
      ORDER BY (parent_id IS NOT NULL), display_order, id`
  );
  const delRows = db.prepare(
    "DELETE FROM shift_checklist_items WHERE branch_id = ? AND type = ?"
  );
  const insRow = db.prepare(
    `INSERT INTO shift_checklist_items (${COPY_COLS.join(", ")}, parent_id, branch_id)
     VALUES (${COPY_COLS.map((c) => "@" + c).join(", ")}, @parent_id, @branch_id)`
  );

  const perType = {} as CopySummary["perType"];

  for (const type of types) {
    const del = delRows.run(dstBranchId, type);
    const src = selRows.all(srcBranchId, type) as Row[];
    // old parent id → freshly-inserted id. Parents come first thanks to the
    // ORDER BY (parent_id IS NOT NULL), so a child's parent is always mapped
    // by the time we reach it.
    const idMap = new Map<number, number>();
    let inserted = 0;
    for (const r of src) {
      const params: Record<string, unknown> = { branch_id: dstBranchId };
      for (const c of COPY_COLS) params[c] = r[c];
      params.parent_id =
        r.parent_id == null ? null : idMap.get(r.parent_id) ?? null;
      const res = insRow.run(params);
      idMap.set(r.id, Number(res.lastInsertRowid));
      inserted++;
    }
    perType[type] = { deleted: del.changes, inserted };
  }

  if (copyHeadline) {
    const scSet = SC_COLS.map((c) => `${c} = @${c}`).join(", ");
    const srcSc = db
      .prepare(`SELECT ${SC_COLS.join(", ")} FROM branches WHERE id = ?`)
      .get(srcBranchId) as Record<string, unknown> | undefined;
    if (srcSc) {
      db.prepare(`UPDATE branches SET ${scSet} WHERE id = @__dst`).run({
        ...srcSc,
        __dst: dstBranchId,
      });
    }
  }

  let channels: CopySummary["channels"] = null;
  if (copyChannels) {
    const del = db.prepare("DELETE FROM accounta_income_channels WHERE branch_id = ?").run(dstBranchId);
    const src = db.prepare(
      `SELECT ${CHANNEL_COLS.join(", ")} FROM accounta_income_channels WHERE branch_id = ? ORDER BY sort_order, name`
    ).all(srcBranchId) as Array<Record<string, unknown>>;
    const insCh = db.prepare(
      `INSERT INTO accounta_income_channels (${CHANNEL_COLS.join(", ")}, branch_id)
       VALUES (${CHANNEL_COLS.map((c) => "@" + c).join(", ")}, @branch_id)`
    );
    for (const r of src) insCh.run({ ...r, branch_id: dstBranchId });
    channels = { deleted: del.changes, inserted: src.length };
  }

  return { perType, headlineCopied: copyHeadline, channels };
}

// ── CLI ────────────────────────────────────────────────────────────────
// Guarded so `import`-ing this file for tests doesn't touch the real DB.
function isMain(): boolean {
  // basename startsWith (not includes) so importing this from
  // verify-copy-branch-checklists.ts doesn't trip the CLI.
  const base = (process.argv[1] ?? "").split("/").pop() ?? "";
  return base.startsWith("copy-branch-checklists");
}

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function branchIdByName(db: BetterSqlite3.Database, name: string): number {
  const row = db
    .prepare("SELECT id FROM branches WHERE name = ?")
    .get(name) as { id: number } | undefined;
  if (!row) {
    console.error(`✗ branch not found: "${name}"`);
    const all = db.prepare("SELECT id, name FROM branches ORDER BY id").all();
    console.error("  available branches:", JSON.stringify(all));
    process.exit(1);
  }
  return row.id;
}

if (isMain()) {
  const fromName = argVal("--from") ?? "NAMA PASTA SRIRACHA";
  const toName = argVal("--to") ?? "HYPOPLARAEMIA";
  const copyHeadline = !process.argv.includes("--no-headline");
  const copyChannels = !process.argv.includes("--no-channels");
  const confirm = process.argv.includes("--yes");

  const db = getDb();
  const srcId = branchIdByName(db, fromName);
  const dstId = branchIdByName(db, toName);
  if (srcId === dstId) {
    console.error("✗ source and target are the same branch — nothing to do");
    process.exit(1);
  }

  console.log(`Copy checklist/readiness config`);
  console.log(`  FROM: ${fromName} (id ${srcId})`);
  console.log(`  TO:   ${toName} (id ${dstId})`);
  console.log(
    `  Types: ${CHECKLIST_TYPES.join(", ")}` +
      (copyHeadline ? " + shift_close headline (sc_*) columns" : "") +
      (copyChannels ? " + income channels (ยอดขายแยกช่องทาง)" : "")
  );
  if (copyChannels) {
    const chCount = (b: number) => (db.prepare("SELECT COUNT(*) AS c FROM accounta_income_channels WHERE branch_id = ?").get(b) as { c: number }).c;
    console.log(`  income channels: ${chCount(srcId)} → ${chCount(dstId)} (target replaced)`);
  }

  // Preview: how many rows each type has on both sides.
  const countBy = db.prepare(
    "SELECT COUNT(*) AS c FROM shift_checklist_items WHERE branch_id = ? AND type = ?"
  );
  console.log("\nCurrent row counts (source → target, target rows will be replaced):");
  for (const t of CHECKLIST_TYPES) {
    const s = (countBy.get(srcId, t) as { c: number }).c;
    const d = (countBy.get(dstId, t) as { c: number }).c;
    console.log(`  ${t.padEnd(16)} ${String(s).padStart(3)} → ${String(d).padStart(3)}`);
  }

  if (!confirm) {
    console.log("\nDRY RUN — no data changed. Re-run with --yes to apply.");
    process.exit(0);
  }

  const summary = db.transaction(() =>
    copyBranchChecklists(db, srcId, dstId, { copyHeadline, copyChannels })
  )();

  console.log("\n✓ Copy complete:");
  for (const t of CHECKLIST_TYPES) {
    const r = summary.perType[t];
    console.log(`  ${t.padEnd(16)} deleted ${r.deleted}, inserted ${r.inserted}`);
  }
  if (summary.headlineCopied) {
    console.log("  shift_close headline (sc_*) columns: copied");
  }
  if (summary.channels) {
    console.log(`  income channels: deleted ${summary.channels.deleted}, inserted ${summary.channels.inserted}`);
  }
  console.log(
    `\n${toName} now mirrors ${fromName} for all four lists. Done.`
  );
}
