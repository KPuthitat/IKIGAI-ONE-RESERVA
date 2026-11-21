// Front-of-house service evaluation (owner 2026-11-21). The supervisor ticks the SOP checklist for a
// person on a day; the day's digest is pushed to the branch LINE group and each person can be told
// their own result with tips. Scores are information for coaching — nothing here touches pay.

import { getDb } from "./db";
import { SERVICE_EVAL_SEED } from "./service-eval-items";

export class EvalError extends Error {
  constructor(public code: string, message?: string) { super(message ?? code); }
}

export type EvalItem = { id: number; code: string; section: "steps" | "donts"; title: string; tip: string | null; sortOrder: number };
export type Result = "pass" | "fail" | "na";
export const bkkToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

/** Seed the checklist once (idempotent — never overwrites edits made later). */
export function ensureSeed(): void {
  const db = getDb();
  const ins = db.prepare("INSERT OR IGNORE INTO service_eval_items (code, section, title, tip, sort_order) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => { SERVICE_EVAL_SEED.forEach((s, i) => ins.run(s.code, s.section, s.title, s.tip, i + 1)); })();
}

export function listItems(): EvalItem[] {
  ensureSeed();
  return (getDb().prepare("SELECT id, code, section, title, tip, sort_order AS sortOrder FROM service_eval_items WHERE active = 1 ORDER BY sort_order").all() as EvalItem[]);
}

export type StaffRow = { id: number; name: string };
/** Employees of the branch who can be evaluated (staff and admins are employees too). */
export function branchStaff(branchId: number): StaffRow[] {
  return getDb().prepare(`
    SELECT u.id, COALESCE(NULLIF(u.nickname_th, ''), u.display_name) AS name
      FROM users u
     WHERE u.role IN ('staff','admin') AND u.status NOT IN ('disabled','resigned','terminated') AND COALESCE(u.is_test_account,0) = 0
       AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = ?)
     ORDER BY name`).all(branchId) as StaffRow[];
}

export const scoreOf = (marks: Array<{ result: Result }>): number | null => {
  const pass = marks.filter((m) => m.result === "pass").length, fail = marks.filter((m) => m.result === "fail").length;
  return pass + fail === 0 ? null : Math.round((pass / (pass + fail)) * 100);
};

export function saveEval(a: {
  branchId: number; date: string; userId: number; evaluatorId: number; note?: string | null;
  marks: Array<{ itemId: number; result: Result; note?: string | null }>;
}): { id: number; score: number | null } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) throw new EvalError("invalid_date");
  if (a.date > bkkToday()) throw new EvalError("date_in_future");
  if (!branchStaff(a.branchId).some((s) => s.id === a.userId)) throw new EvalError("not_in_branch");
  const items = new Map(listItems().map((i) => [i.id, i]));
  const marks = new Map<number, { itemId: number; result: Result; note: string | null }>();
  for (const m of a.marks) {
    if (!items.has(m.itemId)) throw new EvalError("invalid_item");
    if (!["pass", "fail", "na"].includes(m.result)) throw new EvalError("invalid_result");
    marks.set(m.itemId, { itemId: m.itemId, result: m.result, note: m.note?.trim() || null });
  }
  if (marks.size === 0) throw new EvalError("no_marks");
  const list = [...marks.values()];
  const score = scoreOf(list);
  const db = getDb();
  let id = 0;
  db.transaction(() => {
    const prev = db.prepare("SELECT id FROM service_evals WHERE branch_id = ? AND eval_date = ? AND user_id = ?").get(a.branchId, a.date, a.userId) as { id: number } | undefined;
    if (prev) {
      id = prev.id;
      db.prepare("UPDATE service_evals SET evaluator_id = ?, note = ?, score = ?, notified_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(a.evaluatorId, a.note?.trim() || null, score, id);
      db.prepare("DELETE FROM service_eval_marks WHERE eval_id = ?").run(id);
    } else {
      id = Number(db.prepare("INSERT INTO service_evals (branch_id, eval_date, user_id, evaluator_id, note, score) VALUES (?, ?, ?, ?, ?, ?)").run(a.branchId, a.date, a.userId, a.evaluatorId, a.note?.trim() || null, score).lastInsertRowid);
    }
    const ins = db.prepare("INSERT INTO service_eval_marks (eval_id, item_id, result, note) VALUES (?, ?, ?, ?)");
    for (const m of list) ins.run(id, m.itemId, m.result, m.note);
  })();
  return { id, score };
}

export type DayEval = {
  id: number; userId: number; name: string; date: string; score: number | null; note: string | null; evaluator: string; notified: boolean;
  fails: Array<{ itemId: number; code: string; title: string; tip: string | null; note: string | null }>;
  marks: Array<{ itemId: number; result: Result; note: string | null }>;
};

export function listEvals(branchId: number, from: string, to: string): DayEval[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT e.id, e.user_id AS userId, COALESCE(NULLIF(u.nickname_th, ''), u.display_name) AS name, e.eval_date AS date, e.score, e.note,
           COALESCE(NULLIF(v.nickname_th, ''), v.display_name) AS evaluator, e.notified_at AS notifiedAt
      FROM service_evals e JOIN users u ON u.id = e.user_id JOIN users v ON v.id = e.evaluator_id
     WHERE e.branch_id = ? AND e.eval_date BETWEEN ? AND ? ORDER BY e.eval_date DESC, name`).all(branchId, from, to) as Array<Omit<DayEval, "fails" | "marks" | "notified"> & { notifiedAt: string | null }>;
  const mk = db.prepare(`SELECT m.item_id AS itemId, m.result, m.note, i.code, i.title, i.tip FROM service_eval_marks m JOIN service_eval_items i ON i.id = m.item_id WHERE m.eval_id = ? ORDER BY i.sort_order`);
  return rows.map(({ notifiedAt, ...r }) => {
    const ms = mk.all(r.id) as Array<{ itemId: number; result: Result; note: string | null; code: string; title: string; tip: string | null }>;
    return { ...r, notified: !!notifiedAt,
      marks: ms.map((m) => ({ itemId: m.itemId, result: m.result, note: m.note })),
      fails: ms.filter((m) => m.result === "fail").map((m) => ({ itemId: m.itemId, code: m.code, title: m.title, tip: m.tip, note: m.note })) };
  });
}

export type Summary = {
  from: string; to: string; evals: number; avgScore: number | null;
  people: Array<{ userId: number; name: string; evals: number; avgScore: number | null; lastScore: number | null; trend: "up" | "down" | "flat" | null }>;
  topFails: Array<{ code: string; title: string; count: number }>;
};

/** Per-person averages, the most often missed items, and whether each person is moving up or down. */
export function summarize(branchId: number, from: string, to: string): Summary {
  const evals = listEvals(branchId, from, to);
  const byUser = new Map<number, DayEval[]>();
  for (const e of evals) byUser.set(e.userId, [...(byUser.get(e.userId) ?? []), e]);
  const avg = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null; };
  const people = [...byUser.entries()].map(([userId, list]) => {
    const asc = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const half = Math.floor(asc.length / 2);
    const first = avg(asc.slice(0, half).map((e) => e.score)), second = avg(asc.slice(asc.length - half).map((e) => e.score));
    const trend = half === 0 || first == null || second == null ? null : second - first >= 5 ? "up" : first - second >= 5 ? "down" : "flat";
    return { userId, name: list[0].name, evals: list.length, avgScore: avg(list.map((e) => e.score)), lastScore: asc[asc.length - 1].score, trend: trend as "up" | "down" | "flat" | null };
  }).sort((a, b) => (a.avgScore ?? 101) - (b.avgScore ?? 101) || a.name.localeCompare(b.name, "th"));
  const counts = new Map<string, { code: string; title: string; count: number }>();
  for (const e of evals) for (const f of e.fails) { const c = counts.get(f.code) ?? { code: f.code, title: f.title, count: 0 }; c.count++; counts.set(f.code, c); }
  return { from, to, evals: evals.length, avgScore: avg(evals.map((e) => e.score)), people, topFails: [...counts.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, 5) };
}

export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** Monday–Sunday week that contains `d`. */
export function weekOf(d: string): { from: string; to: string } {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); const back = (dow + 6) % 7;
  const from = addDays(d, -back); return { from, to: addDays(from, 6) };
}

// ── LINE cards ───────────────────────────────────────────────────────────

type Flex = { type: "flex"; altText: string; contents: unknown };
const scoreColor = (s: number | null) => s == null ? "#64748b" : s >= 90 ? "#15803d" : s >= 70 ? "#b45309" : "#b91c1c";
const thDate = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return `${dd}/${m}/${y + 543}`; };

/** The digest for the branch group: who was evaluated, scores, and what was missed. */
export function digestFlex(args: { branchName: string; date: string; evals: DayEval[]; weekly?: Summary }): Flex {
  const { branchName, date, evals } = args;
  const rows = evals.map((e) => ({
    type: "box", layout: "vertical", margin: "md", spacing: "xs", contents: [
      { type: "box", layout: "horizontal", contents: [
        { type: "text", text: e.name, size: "sm", weight: "bold", flex: 5, wrap: true, color: "#1a1a2e" },
        { type: "text", text: e.score == null ? "-" : `${e.score}%`, size: "sm", weight: "bold", align: "end", flex: 2, color: scoreColor(e.score) }
      ] },
      ...(e.fails.length ? e.fails.map((f) => ({ type: "text", text: `• ${f.title}${f.note ? ` (${f.note})` : ""}`, size: "xs", color: "#b91c1c", wrap: true })) : [{ type: "text", text: "ผ่านทุกข้อที่ประเมิน", size: "xs", color: "#15803d" }]),
      ...(e.note ? [{ type: "text", text: `หมายเหตุ: ${e.note}`, size: "xs", color: "#64748b", wrap: true }] : [])
    ]
  }));
  const avg = (() => { const v = evals.map((e) => e.score).filter((x): x is number => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null; })();
  const w = args.weekly;
  return {
    type: "flex", altText: `ผลประเมินการบริการ ${branchName} ${thDate(date)}`,
    contents: {
      type: "bubble", size: "giga",
      header: { type: "box", layout: "vertical", backgroundColor: "#281a0e", paddingAll: "18px", contents: [
        { type: "text", text: "NOKHOOK OS · ประเมินการบริการ", color: "#d6a14d", size: "xxs", weight: "bold" },
        { type: "text", text: `${branchName} · ${thDate(date)}`, color: "#ffffff", size: "lg", weight: "bold", wrap: true, margin: "md" },
        { type: "text", text: `ประเมิน ${evals.length} คน · เฉลี่ย ${avg == null ? "-" : avg + "%"}`, color: "#ffffffcc", size: "xs", margin: "sm" }
      ] },
      body: { type: "box", layout: "vertical", paddingAll: "18px", contents: [
        ...rows,
        ...(w && w.topFails.length ? [
          { type: "separator", margin: "lg" },
          { type: "text", text: `ข้อที่พลาดบ่อยในสัปดาห์นี้ (${thDate(w.from)}–${thDate(w.to)})`, size: "xs", weight: "bold", margin: "md", color: "#0e2724", wrap: true },
          ...w.topFails.map((f) => ({ type: "text", text: `• ${f.title} — ${f.count} ครั้ง`, size: "xs", color: "#333333", wrap: true }))
        ] : [])
      ] }
    }
  };
}

/** What one person is told about their own day: what to improve, in the SOP's own words. */
export function personalFlex(args: { branchName: string; e: DayEval }): Flex {
  const { e } = args;
  const lines = e.fails.length
    ? e.fails.flatMap((f) => [
        { type: "text", text: `• ${f.title}`, size: "sm", weight: "bold", wrap: true, color: "#1a1a2e", margin: "md" },
        ...(f.tip ? [{ type: "text", text: `แนวทาง: ${f.tip}`, size: "xs", color: "#475569", wrap: true }] : [])
      ])
    : [{ type: "text", text: "ผ่านทุกข้อที่ประเมิน ขอบคุณที่ดูแลลูกค้าเป็นอย่างดีค่ะ", size: "sm", color: "#15803d", wrap: true }];
  return {
    type: "flex", altText: `ผลประเมินการบริการของคุณ ${thDate(e.date)}`,
    contents: {
      type: "bubble", size: "giga",
      header: { type: "box", layout: "vertical", backgroundColor: "#281a0e", paddingAll: "18px", contents: [
        { type: "text", text: "NOKHOOK OS · ประเมินการบริการ", color: "#d6a14d", size: "xxs", weight: "bold" },
        { type: "text", text: `ผลประเมินวันที่ ${thDate(e.date)}`, color: "#ffffff", size: "lg", weight: "bold", margin: "md" },
        { type: "text", text: `${args.branchName} · คะแนน ${e.score == null ? "-" : e.score + "%"}`, color: "#ffffffcc", size: "xs", margin: "sm" }
      ] },
      body: { type: "box", layout: "vertical", paddingAll: "18px", contents: lines }
    }
  };
}
