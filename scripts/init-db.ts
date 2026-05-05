/**
 * สร้างไฟล์ฐานข้อมูล + schema + บัญชีแอดมินเริ่มต้น + 2 สาขา + โต๊ะตัวอย่าง
 * รัน:  npm run db:init
 */
import fs from "node:fs";
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
import { getDb } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";

const db = getDb();

const branchSeed = [
  { slug: "nama-sriracha", name: "NAMA PASTA SRIRACHA" },
  { slug: "hypoplaraemia", name: "HYPOPLARAEMIA" }
];

console.log("→ Seeding branches...");
const insertBranch = db.prepare(
  "INSERT OR IGNORE INTO branches (slug, name) VALUES (?, ?)"
);
for (const b of branchSeed) insertBranch.run(b.slug, b.name);

const branches = db.prepare("SELECT * FROM branches").all() as Array<{ id: number; slug: string }>;

console.log("→ Seeding sample tables for each branch...");
const insertTable = db.prepare(`
  INSERT OR IGNORE INTO tables (branch_id, label, capacity, shape, x, y, width, height)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const br of branches) {
  // 8 โต๊ะตัวอย่าง วาง grid 4x2
  let i = 1;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      const cap = i <= 4 ? 2 : i <= 6 ? 4 : 6;
      insertTable.run(
        br.id, `T${i}`, cap, cap === 2 ? "round" : "rect",
        60 + col * 130, 60 + row * 130,
        cap === 2 ? 70 : cap === 4 ? 90 : 120,
        cap === 2 ? 70 : cap === 4 ? 90 : 90
      );
      i++;
    }
  }
}

console.log("→ Creating default admin (admin / admin1234) ...");
const adminExists = db.prepare("SELECT id FROM users WHERE username = ?").get("admin");
if (!adminExists) {
  const result = db.prepare(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES (?,?,?,?)"
  ).run("admin", hashPassword("admin1234"), "ผู้ดูแลระบบ", "admin");
  const userId = result.lastInsertRowid as number;
  for (const br of branches) {
    db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)").run(userId, br.id);
  }
  console.log("  admin created. Please change password after first login.");
} else {
  console.log("  admin already exists, skipped.");
}

console.log("✓ Done. DB ready at", process.env.DATABASE_PATH || "./data/reserva.db");
