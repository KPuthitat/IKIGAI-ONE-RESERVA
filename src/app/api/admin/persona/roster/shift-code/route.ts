import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// CRUD for shift codes (TC-R). Always scoped to the admin's active
// branch — no branch_id in the body, so privilege escalation by
// switching the id is impossible.

const TimeRe = /^([01]?\d|2[0-3]):[0-5]\d$/;
const HexRe = /^#?[0-9a-fA-F]{3,8}$/;

const CreateBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().max(120).nullable().optional(),
  start_time: z.string().regex(TimeRe, "invalid_time"),
  end_time: z.string().regex(TimeRe, "invalid_time"),
  break_start: z.string().regex(TimeRe, "invalid_time").nullable().optional(),
  break_end: z.string().regex(TimeRe, "invalid_time").nullable().optional(),
  color: z.string().regex(HexRe, "invalid_color").nullable().optional(),
  display_order: z.number().int().min(0).max(999).optional()
});

const UpdateBody = CreateBody.partial().extend({
  id: z.number().int().positive(),
  active: z.boolean().optional()
});

function normalizeColor(c: string | null | undefined): string | null {
  if (!c) return null;
  const t = c.trim();
  if (!t) return null;
  return t.startsWith("#") ? t.toLowerCase() : `#${t.toLowerCase()}`;
}
function padTime(t: string): string {
  const [h, m] = t.split(":");
  return `${h.padStart(2, "0")}:${m}`;
}

// POST = create. PATCH = update by id. DELETE = soft delete (active=0).
// We soft-delete rather than hard-delete because shift_code_id is a
// FK target from roster_assignments — hard-deleting would orphan
// historical rosters. Soft delete just hides it from the picker.

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!userHasBranch(user, user.activeBranchId)) return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });

  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const db = getDb();
  try {
    const r = db.prepare(`
      INSERT INTO shift_codes
        (branch_id, code, name, start_time, end_time, break_start, break_end, color, display_order, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      user.activeBranchId,
      d.code.trim(),
      d.name?.trim() || null,
      padTime(d.start_time),
      padTime(d.end_time),
      d.break_start ? padTime(d.break_start) : null,
      d.break_end ? padTime(d.break_end) : null,
      normalizeColor(d.color),
      d.display_order ?? 0
    );
    const id = Number(r.lastInsertRowid);
    logPersonaAction(user.id, "roster.shift_code.create", id);
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return NextResponse.json({ error: "code_duplicate" }, { status: 409 });
    }
    throw e;
  }
}

export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const parsed = UpdateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const db = getDb();
  const target = db.prepare("SELECT branch_id FROM shift_codes WHERE id = ?").get(d.id) as { branch_id: number } | undefined;
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.branch_id !== user.activeBranchId) return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });

  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  if (d.code !== undefined)          { sets.push("code = ?");          vals.push(d.code.trim()); }
  if (d.name !== undefined)          { sets.push("name = ?");          vals.push(d.name?.trim() || null); }
  if (d.start_time !== undefined)    { sets.push("start_time = ?");    vals.push(padTime(d.start_time)); }
  if (d.end_time !== undefined)      { sets.push("end_time = ?");      vals.push(padTime(d.end_time)); }
  if (d.break_start !== undefined)   { sets.push("break_start = ?");   vals.push(d.break_start ? padTime(d.break_start) : null); }
  if (d.break_end !== undefined)     { sets.push("break_end = ?");     vals.push(d.break_end ? padTime(d.break_end) : null); }
  if (d.color !== undefined)         { sets.push("color = ?");         vals.push(normalizeColor(d.color)); }
  if (d.display_order !== undefined) { sets.push("display_order = ?"); vals.push(d.display_order); }
  if (d.active !== undefined)        { sets.push("active = ?");        vals.push(d.active ? 1 : 0); }
  if (sets.length === 0) return NextResponse.json({ error: "no_fields" }, { status: 400 });
  vals.push(d.id);
  try {
    db.prepare(`UPDATE shift_codes SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return NextResponse.json({ error: "code_duplicate" }, { status: 409 });
    }
    throw e;
  }
  logPersonaAction(user.id, "roster.shift_code.update", d.id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const db = getDb();
  const target = db.prepare("SELECT branch_id FROM shift_codes WHERE id = ?").get(id) as { branch_id: number } | undefined;
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.branch_id !== user.activeBranchId) return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });

  db.prepare("UPDATE shift_codes SET active = 0 WHERE id = ?").run(id);
  logPersonaAction(user.id, "roster.shift_code.delete", id);
  return NextResponse.json({ ok: true });
}
