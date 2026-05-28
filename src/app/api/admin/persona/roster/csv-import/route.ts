import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { upsertAssignment, recordPublish } from "@/lib/roster";

// POST /api/admin/persona/roster/csv-import
//
// Bulk-load a month's worth of roster assignments from a CSV. Saves
// the admin from clicking 100+ cells by hand when copying schedule
// from a spreadsheet they already maintain offline.
//
// Expected CSV format (long-form, one assignment per row):
//
//   date,position,username,shift_code
//   2026-06-01,Cashier,alice,M
//   2026-06-01,Kitchen,bob,F
//   2026-06-02,Cashier,alice,E
//
// Column rules:
//   - date         YYYY-MM-DD (Bangkok calendar)
//   - position     Matches roster_positions.title (case-insensitive)
//                  in the admin's ACTIVE branch.
//   - username     Matches users.username — must be assigned to the
//                  branch via user_branches.
//   - shift_code   Matches shift_codes.code in the branch.
//
// Lookups are case-insensitive for position/shift_code so admins
// keying from a spreadsheet don't have to match the exact casing.
// Header row is required. Empty lines + lines starting with # are
// skipped (comments). Trailing whitespace/BOM trimmed.
//
// Each row UPSERTS — same date+position combo overwrites the prior
// assignment (matches the assign-cell flow's behaviour). Idempotent
// so re-uploading a corrected sheet doesn't duplicate rows.
//
// Returns:
//   { ok, imported, skipped, errors: [{ line, reason }] }
//
// errors contains per-row failures; the import does NOT abort on
// the first failure — we process every row so the admin can fix
// many issues in one pass instead of one at a time.

const Body = z.object({
  csv: z.string().min(1).max(500_000)  // ~500KB cap = ~10k rows
});

type AssignmentRow = {
  date: string;
  position: string;
  username: string;
  shiftCode: string;
};

type ImportError = { line: number; reason: string };

/** Tiny CSV row parser — handles plain comma-separated values with
 *  optional double-quoted fields. We don't need a full RFC-4180
 *  implementation here; the columns are all simple identifiers
 *  (date / title / username / code) so we accept double-quoted
 *  fields only as a courtesy when admin pastes from Excel. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { buf += '"'; i++; }  // escaped quote
        else { inQuotes = false; }
      } else {
        buf += c;
      }
    } else {
      if (c === ",") {
        cells.push(buf);
        buf = "";
      } else if (c === '"' && buf.length === 0) {
        inQuotes = true;
      } else {
        buf += c;
      }
    }
  }
  cells.push(buf);
  return cells.map((c) => c.trim());
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!userHasBranch(user, user.activeBranchId)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }

  // Strip BOM, normalise line endings
  let text = parsed.data.csv;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = text.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  // Find + validate header row (skip leading blanks/comments).
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    headerIdx = i;
    break;
  }
  if (headerIdx < 0) {
    return NextResponse.json({ error: "empty_csv" }, { status: 400 });
  }
  const headerCells = parseCsvLine(lines[headerIdx]).map((c) => c.toLowerCase());
  const requiredCols = ["date", "position", "username", "shift_code"];
  const colIdx: Record<string, number> = {};
  for (const col of requiredCols) {
    const idx = headerCells.indexOf(col);
    if (idx < 0) {
      return NextResponse.json(
        { error: "missing_column", column: col, expected: requiredCols.join(",") },
        { status: 400 }
      );
    }
    colIdx[col] = idx;
  }

  // Pre-build lookup maps for this branch so we don't run N queries
  // per row. All three lookups are case-insensitive on the human-
  // facing key (position title, shift code, username).
  const db = getDb();
  const positions = db.prepare(
    "SELECT id, title FROM roster_positions WHERE branch_id = ? AND active = 1"
  ).all(user.activeBranchId) as Array<{ id: number; title: string }>;
  const shiftCodes = db.prepare(
    "SELECT id, code FROM shift_codes WHERE branch_id = ? AND active = 1"
  ).all(user.activeBranchId) as Array<{ id: number; code: string }>;
  const users = db.prepare(`
    SELECT u.id, u.username
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    WHERE ub.branch_id = ? AND u.status NOT IN ('disabled', 'resigned')
  `).all(user.activeBranchId) as Array<{ id: number; username: string }>;
  const positionByTitle = new Map(positions.map((p) => [p.title.toLowerCase(), p.id]));
  const shiftByCode = new Map(shiftCodes.map((s) => [s.code.toLowerCase(), s.id]));
  const userByUsername = new Map(users.map((u) => [u.username.toLowerCase(), u.id]));

  // Walk every non-header row, accumulate per-row failures, upsert
  // the successful ones. We process all rows even if some fail so
  // the admin sees the whole error list in one pass.
  const rows: Array<{ lineNo: number; parsed: AssignmentRow }> = [];
  const errors: ImportError[] = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cells = parseCsvLine(raw);
    if (cells.length < requiredCols.length) {
      errors.push({ line: i + 1, reason: "too_few_columns" });
      continue;
    }
    const date = cells[colIdx.date];
    const position = cells[colIdx.position];
    const username = cells[colIdx.username];
    const shiftCode = cells[colIdx.shift_code];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push({ line: i + 1, reason: `bad_date:${date}` });
      continue;
    }
    if (!positionByTitle.has(position.toLowerCase())) {
      errors.push({ line: i + 1, reason: `unknown_position:${position}` });
      continue;
    }
    if (!userByUsername.has(username.toLowerCase())) {
      errors.push({ line: i + 1, reason: `unknown_user:${username}` });
      continue;
    }
    if (!shiftByCode.has(shiftCode.toLowerCase())) {
      errors.push({ line: i + 1, reason: `unknown_shift_code:${shiftCode}` });
      continue;
    }
    rows.push({ lineNo: i + 1, parsed: { date, position, username, shiftCode } });
  }

  // Apply upserts inside a single transaction so a mid-batch crash
  // doesn't leave the roster half-imported. better-sqlite3 hands us
  // the transaction wrapper out of the box.
  let imported = 0;
  const tx = db.transaction(() => {
    for (const { parsed } of rows) {
      upsertAssignment({
        branchId: user.activeBranchId!,
        date: parsed.date,
        positionId: positionByTitle.get(parsed.position.toLowerCase())!,
        userId: userByUsername.get(parsed.username.toLowerCase())!,
        shiftCodeId: shiftByCode.get(parsed.shiftCode.toLowerCase())!,
        actingUserId: user.id
      });
      imported++;
    }
  });
  tx();

  // Bump the "last edited" timestamps for each touched month so the
  // staff calendar's "ตารางแก้ไขล่าสุด" banner reflects the import.
  // De-dupe to avoid hammering the same month for big imports.
  const touchedMonths = new Set(rows.map((r) => r.parsed.date.slice(0, 7)));
  for (const ym of touchedMonths) {
    recordPublish(user.activeBranchId, ym, "edit", user.id, null);
  }

  logPersonaAction(user.id, "roster.csv_import", imported);

  return NextResponse.json({
    ok: true,
    imported,
    skipped: errors.length,
    errors: errors.slice(0, 50)  // cap so the response isn't huge on a bad file
  });
}
