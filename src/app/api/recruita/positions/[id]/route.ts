import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";

// GET    /api/recruita/positions/[id]        — single position (admin)
// GET    /api/recruita/positions/[id]?public=1 — public detail (no auth)
// PATCH  /api/recruita/positions/[id]        — edit (super_admin)
// DELETE /api/recruita/positions/[id]        — close (soft) or hard
//                                              delete if no applications

const CustomQuestionConfig = z.object({
  multiline: z.boolean().optional(),
  max_length: z.number().int().min(1).max(5000).optional(),
  options: z.array(z.object({
    value: z.string().min(1).max(200),
    label: z.string().min(1).max(200)
  })).max(50).optional(),
  allow_other: z.boolean().optional(),
  scale: z.number().int().min(2).max(10).optional(),
  icon: z.enum(["star", "number"]).optional(),
  rows: z.array(z.object({
    value: z.string().min(1).max(200),
    label: z.string().min(1).max(200)
  })).max(20).optional(),
  cols: z.array(z.object({
    value: z.string().min(1).max(200),
    label: z.string().min(1).max(200)
  })).max(10).optional()
}).strict().optional();

const CustomQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  order: z.number().int(),
  required: z.boolean(),
  type: z.enum(["text", "single", "multi", "rating", "grid"]),
  label: z.string().trim().min(1).max(500),
  hint: z.string().max(500).optional(),
  config: CustomQuestionConfig
});

const Body = z.object({
  branch_id: z.number().int().positive().nullable().optional(),
  code: z.string().trim().max(60).nullable().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  department: z.string().trim().max(120).nullable().optional(),
  employment_type: z.enum(["ft", "pt", "contract"]).nullable().optional(),
  jd_summary: z.string().max(1000).nullable().optional(),
  jd_full: z.string().max(20000).nullable().optional(),
  requirements: z.string().max(10000).nullable().optional(),
  benefits: z.string().max(10000).nullable().optional(),
  salary_min: z.number().min(0).nullable().optional(),
  salary_max: z.number().min(0).nullable().optional(),
  salary_type: z.enum(["hourly", "daily", "monthly"]).optional(),
  vacancies: z.number().int().min(0).max(1000).optional(),
  custom_questions: z.array(CustomQuestionSchema).max(100).optional(),
  status: z.enum(["open", "closed", "draft"]).optional()
});

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const url = new URL(req.url);
  const publicMode = url.searchParams.get("public") === "1";
  const db = getDb();

  if (publicMode) {
    const row = db.prepare(`
      SELECT p.id, p.code, p.title, p.department, p.employment_type,
             p.jd_summary, p.jd_full, p.requirements, p.benefits,
             p.salary_min, p.salary_max, p.vacancies, p.custom_questions,
             p.status, p.opened_at, p.branch_id,
             b.name AS branch_name
      FROM recruita_positions p
      LEFT JOIN branches b ON b.id = p.branch_id
      WHERE p.id = ? AND p.status = 'open'
    `).get(id);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, position: row });
  }

  requireSuperAdmin();
  const row = db.prepare(`
    SELECT p.*, b.name AS branch_name
    FROM recruita_positions p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.id = ?
  `).get(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, position: row });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  requireSuperAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const d = parsed.data;
  if (d.salary_min != null && d.salary_max != null && d.salary_max < d.salary_min) {
    return NextResponse.json({ error: "salary_max_less_than_min" }, { status: 400 });
  }
  const db = getDb();
  const row = db.prepare("SELECT id FROM recruita_positions WHERE id = ?").get(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const fields: string[] = [];
  const vals: Array<string | number | null> = [];
  const set = (c: string, v: string | number | null | undefined) => {
    if (v !== undefined) { fields.push(`${c} = ?`); vals.push(v ?? null); }
  };
  set("branch_id", d.branch_id);
  if (d.code !== undefined) set("code", d.code?.trim() || null);
  if (d.title !== undefined) set("title", d.title.trim());
  if (d.department !== undefined) set("department", d.department?.trim() || null);
  set("employment_type", d.employment_type);
  if (d.jd_summary !== undefined) set("jd_summary", d.jd_summary?.trim() || null);
  if (d.jd_full !== undefined) set("jd_full", d.jd_full?.trim() || null);
  if (d.requirements !== undefined) set("requirements", d.requirements?.trim() || null);
  if (d.benefits !== undefined) set("benefits", d.benefits?.trim() || null);
  set("salary_min", d.salary_min);
  set("salary_max", d.salary_max);
  set("salary_type", d.salary_type);
  set("vacancies", d.vacancies);
  if (d.custom_questions !== undefined) {
    set("custom_questions", JSON.stringify(d.custom_questions));
  }
  if (d.status !== undefined) {
    set("status", d.status);
    if (d.status === "closed") {
      fields.push("closed_at = CURRENT_TIMESTAMP");
    }
  }
  if (fields.length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  fields.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(id);
  db.prepare(`UPDATE recruita_positions SET ${fields.join(", ")} WHERE id = ?`)
    .run(...vals);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  requireSuperAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const row = db.prepare("SELECT id FROM recruita_positions WHERE id = ?").get(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Hard delete only when there are no applications attached;
  // otherwise close so the audit trail (which application went to
  // which position) survives. The admin UI uses this signal.
  const apps = db.prepare(
    "SELECT COUNT(*) AS n FROM recruita_applications WHERE position_id = ?"
  ).get(id) as { n: number };
  if (apps.n > 0) {
    db.prepare(
      "UPDATE recruita_positions SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(id);
    return NextResponse.json({ ok: true, action: "closed" });
  }
  db.prepare("DELETE FROM recruita_positions WHERE id = ?").run(id);
  return NextResponse.json({ ok: true, action: "deleted" });
}
