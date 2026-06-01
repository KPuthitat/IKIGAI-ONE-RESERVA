import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";

// GET  /api/recruita/positions       — list positions (admin)
// GET  /api/recruita/positions?public=1 — public list (no auth) for
//                                         the candidate-facing
//                                         positions board
// POST /api/recruita/positions       — create new (super_admin)

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
  title: z.string().trim().min(1).max(200),
  department: z.string().trim().max(120).nullable().optional(),
  employment_type: z.enum(["ft", "pt", "contract"]).nullable().optional(),
  jd_summary: z.string().max(1000).nullable().optional(),
  jd_full: z.string().max(20000).nullable().optional(),
  requirements: z.string().max(10000).nullable().optional(),
  benefits: z.string().max(10000).nullable().optional(),
  salary_min: z.number().min(0).nullable().optional(),
  salary_max: z.number().min(0).nullable().optional(),
  salary_type: z.enum(["hourly", "daily", "monthly"]).default("monthly"),
  vacancies: z.number().int().min(0).max(1000).default(1),
  custom_questions: z.array(CustomQuestionSchema).max(100).default([]),
  status: z.enum(["open", "closed", "draft"]).default("open")
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const publicMode = url.searchParams.get("public") === "1";
  const db = getDb();

  if (publicMode) {
    // Public list — only open positions, minimal fields (no JD
    // markdown body; that lands on the detail page).
    const rows = db.prepare(`
      SELECT p.id, p.code, p.title, p.department, p.employment_type,
             p.jd_summary, p.salary_min, p.salary_max, p.vacancies,
             p.status, p.opened_at, p.branch_id,
             b.name AS branch_name
      FROM recruita_positions p
      LEFT JOIN branches b ON b.id = p.branch_id
      WHERE p.status = 'open'
      ORDER BY p.opened_at DESC
    `).all();
    return NextResponse.json({ ok: true, positions: rows });
  }

  // Admin list — everything including drafts + closed.
  const user = requireSuperAdmin();
  const rows = db.prepare(`
    SELECT p.*,
           b.name AS branch_name,
           (SELECT COUNT(*) FROM recruita_applications a
              WHERE a.position_id = p.id) AS application_count,
           (SELECT COUNT(*) FROM recruita_applications a
              WHERE a.position_id = p.id AND a.stage = 'hired') AS hired_count
    FROM recruita_positions p
    LEFT JOIN branches b ON b.id = p.branch_id
    ORDER BY
      CASE p.status
        WHEN 'open' THEN 0
        WHEN 'draft' THEN 1
        WHEN 'closed' THEN 2
      END,
      p.opened_at DESC
  `).all();
  void user;
  return NextResponse.json({ ok: true, positions: rows });
}

export async function POST(req: Request) {
  const user = requireSuperAdmin();
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
  const info = db.prepare(`
    INSERT INTO recruita_positions
      (branch_id, code, title, department, employment_type,
       jd_summary, jd_full, requirements, benefits,
       salary_min, salary_max, salary_type, vacancies, custom_questions,
       status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    d.branch_id ?? null,
    d.code?.trim() || null,
    d.title.trim(),
    d.department?.trim() || null,
    d.employment_type ?? null,
    d.jd_summary?.trim() || null,
    d.jd_full?.trim() || null,
    d.requirements?.trim() || null,
    d.benefits?.trim() || null,
    d.salary_min ?? null,
    d.salary_max ?? null,
    d.salary_type,
    d.vacancies,
    JSON.stringify(d.custom_questions),
    d.status,
    user.id
  );
  return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid) });
}
