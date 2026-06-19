// RBAC migration-safety + behaviour proof.
//
// The #1 risk of an access-control change is locking people out. This
// script clones the (already-migrated) dev DB, lets getDb() run the RBAC
// seed + backfill on the clone, then proves:
//   • every EXISTING user's effective access is IDENTICAL pre/post-RBAC
//     (no regression — the safety guarantee from CLAUDE.md)
//   • current admins were backfilled with the all-modules system role
//   • assigning a custom role grants exactly its module(s) and lets a
//     plain staffer into the console; revoking it takes access away
//   • the system role cannot be deleted
//   • permission-key sanitisation drops junk
//
// Run:  node --import tsx scripts/test-rbac.ts   (or: npm run test:rbac)

import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "data", "reserva.db");
const TMP = path.join(process.cwd(), "data", "test-rbac.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}
cleanup();
if (!fs.existsSync(SRC)) {
  console.log("rbac test: skipped (no data/reserva.db to clone)");
  process.exit(0);
}
fs.copyFileSync(SRC, TMP);
for (const ext of ["-wal", "-shm"]) {
  if (fs.existsSync(`${SRC}${ext}`)) fs.copyFileSync(`${SRC}${ext}`, `${TMP}${ext}`);
}
process.env.DATABASE_PATH = TMP;

const MODULES = [
  "persona.manage", "reserva.manage", "recruita.access",
  "insigna.view", "ascenda.view", "accounta.manage"
];

(async () => {
  const dbMod = await import("../src/lib/db");
  const rbac = await import("../src/lib/rbac");
  const {
    getDb, listRbacRoles, getUserPermissions, getUserRoleIds,
    createRbacRole, updateRbacRole, deleteRbacRole, setUserRoles
  } = dbMod;

  let passed = 0;
  let failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  const db = getDb(); // triggers migration (seed + backfill) on the clone

  // ── pure mirrors of the gate logic (auth.ts) so we don't import
  //    next/headers in a plain tsx script ────────────────────────────
  type U = { id: number; role: string; hasBranch: boolean; perms: string[] };
  const hasAdminBranch = (uid: number): boolean =>
    !!db.prepare(
      "SELECT 1 FROM user_branches WHERE user_id = ? AND is_admin = 1 LIMIT 1"
    ).get(uid);

  const oldAdminPass = (u: U) =>
    u.role === "super_admin" || (u.role === "admin" && u.hasBranch);
  const newAdminPass = (u: U) =>
    u.role === "super_admin" || (u.role === "admin" && u.hasBranch) || u.perms.length > 0;
  const newCanModule = (u: U, key: string) => {
    if (u.role === "super_admin") return true;
    if (u.perms.length > 0) return u.perms.includes(key);
    return u.role === "admin" && u.hasBranch;
  };

  // ── A. schema + seed ───────────────────────────────────────────────
  console.log("\nA. schema + seed");
  const tableNames = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all() as Array<{ name: string }>).map((r) => r.name);
  ok("rbac_roles table exists", tableNames.includes("rbac_roles"));
  ok("rbac_role_permissions table exists", tableNames.includes("rbac_role_permissions"));
  ok("rbac_user_roles table exists", tableNames.includes("rbac_user_roles"));

  const roles = listRbacRoles();
  const legacy = roles.find((r) => r.key === "legacy_admin");
  ok("legacy_admin system role seeded", !!legacy);
  ok("legacy_admin is_system = 1", legacy?.is_system === 1);
  ok(
    "legacy_admin grants exactly the 6 modules",
    !!legacy &&
      legacy.permissions.length === MODULES.length &&
      MODULES.every((m) => legacy.permissions.includes(m))
  );

  // ── B. no regression for existing users ────────────────────────────
  console.log("\nB. existing users keep identical access (no lockout)");
  const allUsers = db.prepare(
    "SELECT id, role FROM users WHERE status != 'disabled'"
  ).all() as Array<{ id: number; role: string }>;
  const users: U[] = allUsers.map((r) => ({
    id: r.id,
    role: r.role,
    hasBranch: hasAdminBranch(r.id),
    perms: getUserPermissions(r.id)
  }));

  let regressions = 0;
  let backfilledAdmins = 0;
  for (const u of users) {
    // console entry unchanged
    if (newAdminPass(u) !== oldAdminPass(u)) {
      regressions++;
      console.error(`     · user ${u.id} (${u.role}): console entry changed`);
    }
    // each module: pre (all admins saw all modules) == post
    for (const m of MODULES) {
      if (newCanModule(u, m) !== oldAdminPass(u)) {
        regressions++;
        console.error(`     · user ${u.id} (${u.role}): module ${m} changed`);
      }
    }
    // backfill: every non-super admin who passed requireAdmin must hold
    // the legacy_admin role
    if (u.role === "admin" && u.hasBranch) {
      const rids = getUserRoleIds(u.id);
      if (legacy && rids.includes(legacy.id)) backfilledAdmins++;
      else {
        regressions++;
        console.error(`     · admin ${u.id}: NOT backfilled with legacy_admin role`);
      }
    }
  }
  ok(`scanned ${users.length} active users — zero access regressions`, regressions === 0);
  console.log(`     (backfilled admins: ${backfilledAdmins})`);

  // ── C. new role grants + revokes module access ─────────────────────
  console.log("\nC. assigning a role grants exactly its modules");
  const staffId = Number(db.prepare(`
    INSERT INTO users (username, password_hash, display_name, role, status)
    VALUES ('rbac_test_staff', '!x', 'rbac test staff', 'staff', 'active')
  `).run().lastInsertRowid);

  const recruitaRoleId = createRbacRole("เทส RECRUITA เท่านั้น", null, ["recruita.access"]);
  setUserRoles(staffId, [recruitaRoleId], null);
  let su: U = { id: staffId, role: "staff", hasBranch: false, perms: getUserPermissions(staffId) };
  ok("staff perms == [recruita.access]",
    su.perms.length === 1 && su.perms[0] === "recruita.access");
  ok("staff can enter console (has a role)", newAdminPass(su) === true);
  ok("staff CAN access RECRUITA", newCanModule(su, "recruita.access") === true);
  ok("staff CANNOT access PERSONA", newCanModule(su, "persona.manage") === false);
  ok("staff CANNOT access RESERVA", newCanModule(su, "reserva.manage") === false);

  // revoke
  setUserRoles(staffId, [], null);
  su = { id: staffId, role: "staff", hasBranch: false, perms: getUserPermissions(staffId) };
  ok("after revoke: staff perms empty", su.perms.length === 0);
  ok("after revoke: staff cannot enter console", newAdminPass(su) === false);
  ok("after revoke: staff cannot access RECRUITA", newCanModule(su, "recruita.access") === false);

  // ── D. multi-module role + update ──────────────────────────────────
  console.log("\nD. role editing replaces the permission set");
  const multiId = createRbacRole("เทสหลายโมดูล", "desc", ["persona.manage", "reserva.manage"]);
  let multi = listRbacRoles().find((r) => r.id === multiId)!;
  ok("created role has 2 perms",
    multi.permissions.length === 2 &&
    multi.permissions.includes("persona.manage") &&
    multi.permissions.includes("reserva.manage"));
  updateRbacRole(multiId, "เทสหลายโมดูล (แก้)", null, ["insigna.view"]);
  multi = listRbacRoles().find((r) => r.id === multiId)!;
  ok("update replaced perms to [insigna.view]",
    multi.permissions.length === 1 && multi.permissions[0] === "insigna.view");
  ok("update renamed the role", multi.name === "เทสหลายโมดูล (แก้)");

  // ── E. system role protection + sanitisation ───────────────────────
  console.log("\nE. system role protection + key sanitisation");
  const delLegacy = legacy ? deleteRbacRole(legacy.id) : { ok: true };
  ok("system role cannot be deleted", delLegacy.ok === false && delLegacy.reason === "system_role");
  const delCustom = deleteRbacRole(multiId);
  ok("custom role can be deleted", delCustom.ok === true);
  const delRecruita = deleteRbacRole(recruitaRoleId);
  ok("custom role 2 can be deleted", delRecruita.ok === true);

  const sane = rbac.sanitizePermissionKeys([
    "persona.manage", "bogus.perm", "reserva.manage", "persona.manage"
  ]);
  ok("sanitize drops junk + dedupes",
    sane.length === 2 && sane.includes("persona.manage") && sane.includes("reserva.manage"));

  // ── G. invalid role ids ignored on assignment ──────────────────────
  console.log("\nF. invalid role ids ignored");
  setUserRoles(staffId, [999999], null);
  ok("assigning a non-existent role id stores nothing",
    getUserRoleIds(staffId).length === 0);

  // cleanup test staff
  db.prepare("DELETE FROM rbac_user_roles WHERE user_id = ?").run(staffId);
  db.prepare("DELETE FROM users WHERE id = ?").run(staffId);

  console.log(`\n${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
