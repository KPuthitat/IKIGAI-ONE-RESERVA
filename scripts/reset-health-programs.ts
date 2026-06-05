// One-time reset of the weight-control (Mounjaro) program data.
//
// Owner 2026-06-05: an earlier enrollment (ภูธิทัต) was created under
// incorrect logic. This wipes ALL program enrollment + clinical + self-log
// + audit rows so the program starts as if no one ever enrolled.
//
// KEPT (intentionally):
//   • mounjaro_consent_versions   — the PDPA consent text/versions
//   • health_facilities           — the clinic config
//   • health_checkups             — occupational-health exam results
//                                   (a separate feature, not this program)
//
// Run on the VPS, from /var/www/reserva, with an explicit confirm flag:
//   node --import tsx scripts/reset-health-programs.ts --yes
//
// Without --yes it prints the row counts and exits without changing data.

import { getDb } from "../src/lib/db";

const db = getDb();

const TABLES = [
  "mounjaro_self_logs",
  "mounjaro_visits",
  "mounjaro_patients",
  "mounjaro_enrollments",
  "mounjaro_audit_log"
] as const;

function count(table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  } catch {
    return -1; // table not present (fresh DB) — treated as nothing to wipe
  }
}

const confirm = process.argv.includes("--yes");

console.log("Weight-control (Mounjaro) program — current row counts:");
for (const t of TABLES) console.log(`  ${t}: ${count(t)}`);
console.log("\nKept untouched: mounjaro_consent_versions, health_facilities, health_checkups");

if (!confirm) {
  console.log("\nDRY RUN — no data changed. Re-run with --yes to wipe.");
  process.exit(0);
}

// FK-safe order: children first (self_logs/visits reference patients/
// enrollments; patients reference enrollments). Audit log is standalone.
const tx = db.transaction(() => {
  for (const t of TABLES) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table absent */ }
  }
  // Reset AUTOINCREMENT counters so new enrollments start at id 1 again
  // (cosmetic — the sqlite_sequence row is only present once the table
  //  has had an insert).
  try {
    db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('mounjaro_self_logs','mounjaro_visits','mounjaro_patients','mounjaro_enrollments','mounjaro_audit_log')").run();
  } catch { /* no sequence table yet */ }
});
tx();

console.log("\n✓ Reset complete — counts after wipe:");
for (const t of TABLES) console.log(`  ${t}: ${count(t)}`);
console.log("\nThe weight-control program now has zero enrollments. Done.");
