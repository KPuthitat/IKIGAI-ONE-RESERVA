import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { notifyStageChange, notifyExecGroupStageChange } from "@/lib/recruita-notify";

// POST /api/recruita/my-applications/[id]/offer-response  (public, candidate)
//
// The candidate accepts or rejects a job offer from their status page
// (owner 2026-06-15). Authorisation mirrors the rest of the self-service
// surface: prove ownership by the LINE userId bound to the candidate OR the
// mobile phone on file. Allowed only while the application is at 'offered'.
//   accept → stage 'accepted'  (waits for the admin to hire/import to PORTAL)
//   reject → stage 'withdrawn'  (declined the offer)

const Body = z.object({
  action: z.enum(["accept", "reject"]),
  line_user_id: z.string().regex(/^U[0-9a-fA-F]{32}$/).optional(),
  mobile_phone: z.string().min(9).max(20).optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const appId = Number(params.id);
  if (!Number.isInteger(appId) || appId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad_body" }, { status: 400 });
  }
  const { action, line_user_id, mobile_phone } = parsed.data;
  if (!line_user_id && !mobile_phone) {
    return NextResponse.json({ ok: false, error: "no_identity" }, { status: 400 });
  }

  const db = getDb();
  const app = db.prepare(`
    SELECT a.id, a.stage, c.line_user_id, c.mobile_phone
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    WHERE a.id = ?
  `).get(appId) as
    | { id: number; stage: string; line_user_id: string | null; mobile_phone: string | null }
    | undefined;
  if (!app) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  // Ownership — at least one identity proof must match the candidate. The
  // ≥9-digit floor stops a junk phone (norm → "") matching a NULL phone.
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
  const lineMatches = !!line_user_id && app.line_user_id === line_user_id;
  const phoneMatches = norm(mobile_phone).length >= 9 && norm(app.mobile_phone) === norm(mobile_phone);
  if (!lineMatches && !phoneMatches) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  if (app.stage !== "offered") {
    return NextResponse.json(
      { ok: false, error: "stage_not_offered", message: "ใบสมัครนี้ยังไม่อยู่ในขั้นข้อเสนองาน" },
      { status: 409 }
    );
  }

  const toStage = action === "accept" ? "accepted" : "withdrawn";
  db.prepare(
    "UPDATE recruita_applications SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(toStage, appId);
  console.info(`[recruita] candidate ${action}ed offer → app #${appId} → ${toStage}`);

  // Notify the candidate (confirmation card) + the exec group so an admin
  // knows to proceed (accept) or that the seat reopened (reject).
  void notifyStageChange(appId).catch((e) => console.warn("[recruita] offer-response notify failed", e));
  void notifyExecGroupStageChange(appId).catch((e) => console.warn("[recruita] offer-response exec notify failed", e));

  return NextResponse.json({ ok: true, stage: toStage });
}
