import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/recruita/applications/[id]/link-line
// Body: { line_user_id: "U…" | "" }
//
// Manual link path: when a candidate submitted their application
// without LIFF (direct URL access, or rich-menu flow that lost
// liff.state on internal navigation), candidates.line_user_id is
// NULL and the /recruita/status page can't find their application.
//
// The candidate sees their LINE userId on the status empty-state and
// forwards it to an admin (LINE chat, etc.). Admin opens the
// application detail and pastes it here. This sets the line_user_id
// on the candidate row that backs THIS application — siblings (the
// same candidate's other applications) are linked too because they
// all share one candidates row.
//
// Empty string = clear (admin made a mistake, undo the link).
// SuperAdmin only — touching identity bindings is high-trust.

const Body = z.object({
  // U-prefix is the documented LINE userId shape (33 chars). Allow
  // empty string for "clear". Anything else (typo, partial paste)
  // is rejected at the API boundary.
  line_user_id: z.string()
    .max(80)
    .refine(
      (v) => v === "" || /^U[0-9a-f]{32}$/.test(v),
      { message: "LINE userId ต้องขึ้นต้นด้วย U ตามด้วย 32 ตัวอักษร hex (รวม 33 ตัว)" }
    ),
  // When the userId is already bound to a DIFFERENT candidate (e.g. a
  // stale binding left by the old recency-guess), the first attempt is
  // rejected with userid_in_use. The admin confirms "same person" and
  // re-submits with force:true → we MOVE the binding here (clearing it
  // from the other candidate). A LINE userId belongs to one person, so
  // it must live on exactly one candidate row.
  force: z.boolean().optional()
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  requireAdmin();
  const applicationId = Number(params.id);
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: "invalid_body", message: first?.message ?? "ข้อมูลไม่ถูกต้อง" },
      { status: 400 }
    );
  }
  const db = getDb();
  const app = db.prepare(
    "SELECT candidate_id FROM recruita_applications WHERE id = ?"
  ).get(applicationId) as { candidate_id: number } | undefined;
  if (!app) {
    return NextResponse.json({ error: "application_not_found" }, { status: 404 });
  }

  // If admin is BINDING a userId, sanity-check it isn't already
  // attached to a different candidate — that would silently steal
  // the existing person's notifications. Fail loudly UNLESS the admin
  // confirmed the move (force:true), in which case we relocate it.
  if (parsed.data.line_user_id !== "") {
    const dup = db.prepare(
      "SELECT id FROM recruita_candidates WHERE line_user_id = ? AND id != ?"
    ).get(parsed.data.line_user_id, app.candidate_id) as { id: number } | undefined;
    if (dup && !parsed.data.force) {
      return NextResponse.json(
        {
          error: "userid_in_use",
          other_candidate_id: dup.id,
          message: `LINE userId นี้ถูกเชื่อมต่อกับผู้สมัครรายอื่น (candidate #${dup.id}) อยู่แล้ว — ` +
            `ถ้าเป็นบุคคลเดียวกัน กด "ย้ายมาเชื่อมต่อที่นี่" เพื่อย้ายมาที่ใบสมัครนี้`
        },
        { status: 409 }
      );
    }
    if (dup && parsed.data.force) {
      // Move: clear it from the other candidate(s), then set here — in a
      // transaction so we never end up with it on two rows or none.
      const tx = db.transaction(() => {
        db.prepare(
          "UPDATE recruita_candidates SET line_user_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE line_user_id = ? AND id != ?"
        ).run(parsed.data.line_user_id, app.candidate_id);
        db.prepare(
          "UPDATE recruita_candidates SET line_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).run(parsed.data.line_user_id, app.candidate_id);
      });
      tx();
      return NextResponse.json({ ok: true, moved_from: dup.id });
    }
  }

  db.prepare(
    "UPDATE recruita_candidates SET line_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(parsed.data.line_user_id || null, app.candidate_id);

  return NextResponse.json({ ok: true });
}
