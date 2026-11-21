import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { getLineGroupId } from "@/lib/salesa-db";
import { notifySalesaHod } from "@/lib/salesa-line";
import { pushIndividually } from "@/lib/special-duty-notify";
import { addDays, bkkToday, branchStaff, digestFlex, EvalError, listEvals, listItems, personalFlex, saveEval, summarize, weekOf } from "@/lib/service-eval";

// Front-of-house service evaluation (owner 2026-11-21) — supervisor / owner of the active branch.
//   GET  ?date=YYYY-MM-DD → checklist, staff, that day's evaluations, this week's and last 4 weeks' summary
//   POST {action: save | send_group | notify_staff, ...}

export const dynamic = "force-dynamic";
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ERR_TH: Record<string, string> = {
  invalid_date: "วันที่ไม่ถูกต้อง", date_in_future: "ประเมินล่วงหน้าไม่ได้", not_in_branch: "พนักงานคนนี้ไม่ได้สังกัดสาขานี้",
  invalid_item: "ข้อประเมินไม่ถูกต้อง", invalid_result: "ผลประเมินไม่ถูกต้อง", no_marks: "กรุณาเลือกผลอย่างน้อยหนึ่งข้อ"
};

function gate() {
  const user = getSessionUser();
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) } as const;
  const branchId = user.activeBranchId;
  if (!branchId || !userHasBranch(user, branchId)) return { error: NextResponse.json({ error: "no_active_branch" }, { status: 400 }) } as const;
  if (user.role !== "super_admin" && user.role !== "admin") return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as const;
  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string };
  return { user, branchId, branchName: branch.name } as const;
}

export async function GET(req: Request) {
  const g = gate(); if ("error" in g) return g.error;
  const q = new URL(req.url).searchParams;
  const p = DATE.safeParse(q.get("date") ?? bkkToday());
  if (!p.success) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  const date = p.data;
  const wk = weekOf(date);
  return NextResponse.json({
    date, items: listItems(), staff: branchStaff(g.branchId), evals: listEvals(g.branchId, date, date),
    week: summarize(g.branchId, wk.from, wk.to),
    month: summarize(g.branchId, addDays(date, -27), date),
    hasGroup: !!getLineGroupId(g.branchId)
  });
}

const Body = z.object({
  action: z.enum(["save", "send_group", "notify_staff"]),
  date: DATE.optional(), user_id: z.number().int().optional(), eval_id: z.number().int().optional(), note: z.string().max(500).nullable().optional(),
  marks: z.array(z.object({ item_id: z.number().int(), result: z.enum(["pass", "fail", "na"]), note: z.string().max(200).nullable().optional() })).max(60).optional()
});

export async function POST(req: Request) {
  const g = gate(); if ("error" in g) return g.error;
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = p.data;
  try {
    if (d.action === "save") {
      if (!d.date || !d.user_id || !d.marks) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
      const r = saveEval({ branchId: g.branchId, date: d.date, userId: d.user_id, evaluatorId: g.user.id, note: d.note, marks: d.marks.map((m) => ({ itemId: m.item_id, result: m.result, note: m.note })) });
      logPersonaAction(g.user.id, "service_eval.save", g.branchId);
      return NextResponse.json({ ok: true, ...r });
    }
    if (d.action === "send_group") {
      if (!d.date) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
      const groupId = getLineGroupId(g.branchId);
      if (!groupId) return NextResponse.json({ ok: false, error: "no_group", message: "ยังไม่ได้ตั้งกลุ่ม LINE หัวหน้างานของสาขานี้" }, { status: 409 });
      const evals = listEvals(g.branchId, d.date, d.date);
      if (evals.length === 0) return NextResponse.json({ ok: false, error: "nothing_to_send", message: "ยังไม่มีผลประเมินของวันนี้" }, { status: 409 });
      const wk = weekOf(d.date);
      const r = await notifySalesaHod(groupId, digestFlex({ branchName: g.branchName, date: d.date, evals, weekly: summarize(g.branchId, wk.from, wk.to) }));
      if (!r.ok) return NextResponse.json({ ok: false, error: "push_failed", message: "ส่งเข้ากลุ่ม LINE ไม่สำเร็จ" }, { status: 502 });
      logPersonaAction(g.user.id, "service_eval.send_group", g.branchId);
      return NextResponse.json({ ok: true, count: evals.length });
    }
    // notify_staff: tell one person their own result with tips
    if (!d.eval_id) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    const row = getDb().prepare("SELECT eval_date AS date FROM service_evals WHERE id = ? AND branch_id = ?").get(d.eval_id, g.branchId) as { date: string } | undefined;
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const e = listEvals(g.branchId, row.date, row.date).find((x) => x.id === d.eval_id)!;
    const line = (getDb().prepare("SELECT line_user_id AS l FROM users WHERE id = ?").get(e.userId) as { l: string | null } | undefined)?.l ?? null;
    if (!line) return NextResponse.json({ ok: false, error: "no_line", message: `${e.name} ยังไม่ได้ผูก LINE` }, { status: 409 });
    const sent = await pushIndividually([line], personalFlex({ branchName: g.branchName, e }));
    if (!sent) return NextResponse.json({ ok: false, error: "push_failed", message: "ส่ง LINE ไม่สำเร็จ" }, { status: 502 });
    getDb().prepare("UPDATE service_evals SET notified_at = CURRENT_TIMESTAMP WHERE id = ?").run(d.eval_id);
    logPersonaAction(g.user.id, "service_eval.notify_staff", g.branchId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof EvalError) return NextResponse.json({ ok: false, error: e.code, message: ERR_TH[e.code] ?? e.code }, { status: 422 });
    throw e;
  }
}
