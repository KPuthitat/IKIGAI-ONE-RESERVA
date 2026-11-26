import { NextResponse } from "next/server";
import { z } from "zod";
import { canModule, getSessionUser, type SessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { viewerOf } from "@/lib/purchasing";
import {
  autoMatch, candidatesFor, closePeriod, explainLine, importStatement, listBankAccounts, matchLine, monthSummary, parseStatement, periodsOverview, ReconError, RECON_ERROR_TH, reopenPeriod, setPurpose, unmatchLine, type Columns
} from "@/lib/bank-recon";

// Monthly bank reconciliation (owner 2026-11-26). Owner, executives and ACCOUNTA staff only.
//   GET                          → bank accounts, the months that have lines
//   GET ?account=&period=YYYY-MM → one month: summary, lines, bills paid by transfer but not in the bank
//   GET ?candidates=<lineId>     → what a line could be matched to
//   POST multipart (file, account, mode=preview|import, mapping?) → read a statement / import it
//   POST json {action}           → match | explain | unmatch | auto_match | close | reopen | set_purpose
export const dynamic = "force-dynamic";
const MAX_BYTES = 5 * 1024 * 1024;

function gate(): { user: SessionUser; owner: boolean } | { error: NextResponse } {
  const user = getSessionUser();
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  const v = viewerOf(user);
  if (user.role !== "super_admin" && !v.isCLevel && !canModule(user, "accounta.manage")) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user, owner: user.role === "super_admin" };
}
function fail(e: unknown) {
  if (e instanceof ReconError) return NextResponse.json({ error: e.code, detail: e.detail, message: RECON_ERROR_TH[e.code] }, { status: e.code === "not_found" ? 404 : e.code === "period_closed" || e.code === "already_used" ? 409 : 400 });
  throw e;
}

export async function GET(req: Request) {
  const g = gate(); if ("error" in g) return g.error;
  const q = new URL(req.url).searchParams;
  try {
    const cand = Number(q.get("candidates"));
    if (cand) return NextResponse.json({ ok: true, candidates: candidatesFor(cand) });
    const account = Number(q.get("account")), period = q.get("period") ?? "";
    if (account && /^\d{4}-\d{2}$/.test(period)) return NextResponse.json({ ok: true, summary: monthSummary(account, period) });
    return NextResponse.json({ ok: true, accounts: listBankAccounts(), periods: periodsOverview(), isOwner: g.owner });
  } catch (e) { return fail(e); }
}

const Mapping = z.object({ date: z.number().int().min(0), desc: z.number().int().min(0).nullable(), debit: z.number().int().min(0).nullable(), credit: z.number().int().min(0).nullable(), amount: z.number().int().min(0).nullable(), type: z.number().int().min(0).nullable(), balance: z.number().int().min(0).nullable() });
const Act = z.discriminatedUnion("action", [
  z.object({ action: z.literal("match"), line: z.number().int().positive(), kind: z.enum(["expense", "income", "transfer"]), ref: z.number().int().positive() }),
  z.object({ action: z.literal("explain"), line: z.number().int().positive(), reason: z.string().max(200) }),
  z.object({ action: z.literal("unmatch"), line: z.number().int().positive() }),
  z.object({ action: z.literal("auto_match"), account: z.number().int().positive().optional() }),
  z.object({ action: z.literal("close"), account: z.number().int().positive(), period: z.string().regex(/^\d{4}-\d{2}$/), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("reopen"), account: z.number().int().positive(), period: z.string().regex(/^\d{4}-\d{2}$/) }),
  z.object({ action: z.literal("set_purpose"), account: z.number().int().positive(), purpose: z.enum(["savings", "working", "payroll_tax", "procurement", "other"]).nullable() })
]);

export async function POST(req: Request) {
  const g = gate(); if ("error" in g) return g.error;
  try {
    if ((req.headers.get("content-type") ?? "").startsWith("multipart/")) {
      const f = await req.formData().catch(() => null);
      const file = f?.get("file"), account = Number(f?.get("account"));
      if (!f || !(file instanceof File) || file.size === 0 || !account) return NextResponse.json({ error: "bad_file", message: RECON_ERROR_TH.bad_file }, { status: 400 });
      if (file.size > MAX_BYTES) return NextResponse.json({ error: "bad_file", message: "ไฟล์เกิน 5 MB" }, { status: 400 });
      let mapping: Columns | undefined;
      const rawMap = f.get("mapping");
      if (typeof rawMap === "string" && rawMap) { const m = Mapping.safeParse(JSON.parse(rawMap)); if (!m.success) return NextResponse.json({ error: "no_columns", message: RECON_ERROR_TH.no_columns }, { status: 400 }); mapping = m.data; }
      const parsed = parseStatement(Buffer.from(await file.arrayBuffer()), file.name, mapping);
      if (f.get("mode") !== "import") return NextResponse.json({ ok: true, preview: { ...parsed, lines: parsed.lines.slice(0, 15), lineTotal: parsed.lines.length, totalDebit: Math.round(parsed.lines.reduce((s, l) => s + l.debit, 0) * 100) / 100, totalCredit: Math.round(parsed.lines.reduce((s, l) => s + l.credit, 0) * 100) / 100 } });
      if (!parsed.columns) throw new ReconError("no_columns");
      const r = importStatement(account, file.name, parsed, g.user.id);
      logPersonaAction(g.user.id, "bank_recon.import", r.statementId);
      return NextResponse.json({ ok: true, ...r, chainBreaks: parsed.chainBreaks });
    }
    const p = Act.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    const d = p.data;
    switch (d.action) {
      case "match": matchLine(d.line, d.kind, d.ref, g.user.id); logPersonaAction(g.user.id, "bank_recon.match", d.line); break;
      case "explain": explainLine(d.line, d.reason, g.user.id); logPersonaAction(g.user.id, "bank_recon.explain", d.line); break;
      case "unmatch": unmatchLine(d.line); logPersonaAction(g.user.id, "bank_recon.unmatch", d.line); break;
      case "auto_match": return NextResponse.json({ ok: true, matched: autoMatch(d.account ?? null, g.user.id) });
      case "close": closePeriod(d.account, d.period, d.note ?? "", g.user.id); logPersonaAction(g.user.id, "bank_recon.close", d.account); break;
      case "reopen": if (!g.owner) return NextResponse.json({ error: "forbidden", message: "เฉพาะเจ้าของระบบเปิดงวดที่ปิดแล้วได้" }, { status: 403 }); reopenPeriod(d.account, d.period); logPersonaAction(g.user.id, "bank_recon.reopen", d.account); break;
      case "set_purpose": setPurpose(d.account, d.purpose); break;
    }
    return NextResponse.json({ ok: true });
  } catch (e) { return fail(e); }
}
