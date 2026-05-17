import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// PATCH /api/admin/users/:id — super_admin manages a user's branch
// access and which of those branches they administer.
//
// `grants` fully replaces the user's user_branches rows: each entry
// is a branch the user may enter; is_admin = true additionally makes
// them a branch admin there. Combined with role = 'admin' that turns
// the account into a scoped sub-admin (see requireAdmin / auth.ts).
//
// Locked to super_admin: granting admin powers is itself a
// privilege-escalation surface, so a sub-admin must not reach it.

const Body = z.object({
  role: z.enum(["admin", "staff"]).optional(),
  grants: z
    .array(
      z.object({
        branch_id: z.number().int(),
        is_admin: z.boolean()
      })
    )
    .optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const me = getSessionUser();
  if (!me || me.role !== "super_admin") {
    return NextResponse.json({ error: "เฉพาะผู้ดูแลระบบสูงสุด" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "ไม่พบผู้ใช้" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  }
  const db = getDb();
  const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as
    | { id: number; role: string }
    | undefined;
  if (!target) return NextResponse.json({ error: "ไม่พบผู้ใช้" }, { status: 404 });

  // Never touch a super_admin's role through this endpoint (avoids
  // accidental self-lockout / silent demotion of the system owner).
  if (parsed.data.role && target.role === "super_admin") {
    return NextResponse.json(
      { error: "เปลี่ยนสิทธิ์ผู้ดูแลระบบสูงสุดที่นี่ไม่ได้" },
      { status: 400 }
    );
  }

  // Reject grants pointing at branches that don't exist.
  if (parsed.data.grants && parsed.data.grants.length > 0) {
    const ids = parsed.data.grants.map((g) => g.branch_id);
    const placeholders = ids.map(() => "?").join(",");
    const found = db
      .prepare(`SELECT COUNT(*) AS n FROM branches WHERE id IN (${placeholders})`)
      .get(...ids) as { n: number };
    if (found.n !== new Set(ids).size) {
      return NextResponse.json({ error: "มีสาขาที่ไม่ถูกต้อง" }, { status: 400 });
    }
  }

  const txn = db.transaction(() => {
    if (parsed.data.role) {
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(parsed.data.role, id);
    }
    if (parsed.data.grants) {
      db.prepare("DELETE FROM user_branches WHERE user_id = ?").run(id);
      const ins = db.prepare(
        "INSERT INTO user_branches (user_id, branch_id, is_admin) VALUES (?, ?, ?)"
      );
      // Dedupe by branch_id (last wins) so a malformed payload can't
      // violate the (user_id, branch_id) primary key.
      const byBranch = new Map<number, boolean>();
      for (const g of parsed.data.grants) byBranch.set(g.branch_id, g.is_admin);
      for (const [bid, isAdmin] of byBranch) ins.run(id, bid, isAdmin ? 1 : 0);
    }
  });
  txn();
  return NextResponse.json({ ok: true });
}
