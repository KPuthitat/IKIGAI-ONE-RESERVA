import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { createSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/secret-vault";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/persona/self-register
//
// New-employee self-onboarding via the PORTAL LIFF (owner 2026-06-16).
// Replaces the admin-sends-a-per-user-link flow: a freshly-hired employee
// (status='pending_invite', created by the RECRUITA hire bridge) opens the
// IKIGAI OS PORTAL OA, taps "ลงทะเบียนพนักงานใหม่", proves who they are with
// national_id + date-of-birth (both already on their hire record), and sets
// their own username/password. We bind the VERIFIED LINE userId and flip the
// account to 'active'. The admin no longer has to send a link or paste a
// userId.
//
// Trust / security model:
//   • The LINE userId is NEVER client-asserted — we verify the LIFF
//     accessToken against LINE's Profile API and take the userId from there
//     (same pattern as /api/auth/line-login).
//   • Only status='pending_invite' rows are claimable. Active/disabled/
//     resigned accounts are invisible to this door, so it can't hijack an
//     existing employee or re-activate a disabled one.
//   • Identity match requires BOTH national_id and dob. national_id is
//     encrypted at rest, so we decrypt-compare across the (small) set of
//     pending hires sharing the dob.
//   • Exactly one match required — 0 or >1 both return the SAME generic error
//     so the endpoint is not an oracle on which field was right.
//   • The verified userId must not already be bound to any user.
//   • The claim runs in a transaction that re-checks status='pending_invite',
//     so two racing claims can't both win, and the UNIQUE username index is
//     the final backstop.

const Body = z.object({
  accessToken: z.string().min(20).max(2048),
  national_id: z.string().min(8).max(20),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  username: z.string().trim().min(3).max(40),
  password: z.string().min(6).max(100),
  // Optional 4-digit time-clock PIN; the employee can set it later if omitted.
  pin: z.string().regex(/^\d{4}$/).optional()
});

/** Keep digits only so "1-2345-67890-12-3" and spaces still match the stored
 *  value, which may itself carry formatting. */
function normId(s: string): string {
  return s.replace(/\D/g, "");
}

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const d = parsed.data;
  const inputId = normId(d.national_id);
  if (inputId.length < 8) {
    return NextResponse.json({ error: "invalid_national_id" }, { status: 400 });
  }

  // (0) Rate-limit by client IP before doing any work — caps brute-force of
  //     the national_id + dob space and stops hammering the LINE API / bcrypt
  //     on the 1-vCPU droplet. Nginx forwards the real client IP.
  const ip = (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim())
    || req.headers.get("x-real-ip")
    || "unknown";
  const rl = rateLimit(`self-register:${ip}`, 12, 5 * 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterSec: Math.ceil(rl.retryAfterMs / 1000) },
      { status: 429 }
    );
  }

  // (1) Verify the LIFF accessToken → real, current userId. An invalid /
  //     expired token returns 401 from LINE here too.
  let lineUserId: string;
  try {
    const r = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${d.accessToken}` },
      cache: "no-store"
    });
    if (!r.ok) {
      return NextResponse.json({ error: "invalid_line_token" }, { status: 401 });
    }
    const profile = (await r.json()) as { userId?: string };
    if (!profile.userId) {
      return NextResponse.json({ error: "invalid_line_token" }, { status: 401 });
    }
    lineUserId = profile.userId;
  } catch {
    return NextResponse.json({ error: "line_profile_fetch_failed" }, { status: 502 });
  }

  const db = getDb();

  // (2) The verified userId must not already be bound to someone — don't let a
  //     second person's claim steamroll an existing binding. Generic message;
  //     don't reveal whose account it is.
  const existingBind = db.prepare(
    "SELECT id FROM users WHERE line_user_id = ?"
  ).get(lineUserId) as { id: number } | undefined;
  if (existingBind) {
    return NextResponse.json({ error: "line_already_registered" }, { status: 409 });
  }

  // (3) Find the pending hire matching dob + national_id. dob narrows the set
  //     in SQL; national_id is decrypt-compared (decryptSecret returns the
  //     plaintext for both encrypted and legacy-plaintext storage).
  const candidates = db.prepare(`
    SELECT id, national_id FROM users
    WHERE status = 'pending_invite' AND dob = ?
  `).all(d.dob) as Array<{ id: number; national_id: string | null }>;

  const matches = candidates.filter((u) => {
    const plain = decryptSecret(u.national_id);
    return plain != null && normId(plain) === inputId;
  });

  if (matches.length !== 1) {
    return NextResponse.json({ error: "no_match" }, { status: 404 });
  }
  const targetId = matches[0].id;

  // (4) Username uniqueness pre-check for a friendly error (the UNIQUE index
  //     is the real guard inside the tx below).
  const taken = db.prepare(
    "SELECT 1 FROM users WHERE username = ? AND id != ?"
  ).get(d.username, targetId);
  if (taken) {
    return NextResponse.json({ error: "username_taken" }, { status: 409 });
  }

  // (5) Set credentials + bind userId + activate, atomically. Re-check the row
  //     is still pending inside the tx so two concurrent claims can't both win.
  const passwordHash = bcrypt.hashSync(d.password, 10);
  const pinHash = d.pin ? bcrypt.hashSync(d.pin, 10) : null;
  try {
    const tx = db.transaction(() => {
      const row = db.prepare("SELECT status FROM users WHERE id = ?")
        .get(targetId) as { status: string } | undefined;
      if (!row || row.status !== "pending_invite") return false;
      // Re-check the verified userId isn't bound to anyone else INSIDE the tx
      // (the column has no UNIQUE index) — closes the TOCTOU between the
      // step-(2) check and here, so the same LINE account can't end up bound
      // to two activated users via racing claims.
      const dupe = db.prepare(
        "SELECT id FROM users WHERE line_user_id = ? AND id != ?"
      ).get(lineUserId, targetId) as { id: number } | undefined;
      if (dupe) return false;
      db.prepare(`
        UPDATE users
        SET username = ?, password_hash = ?,
            pin_hash = COALESCE(?, pin_hash),
            line_user_id = ?, status = 'active',
            last_login_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(d.username, passwordHash, pinHash, lineUserId, targetId);
      return true;
    });
    if (!tx()) {
      return NextResponse.json({ error: "already_claimed" }, { status: 409 });
    }
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return NextResponse.json({ error: "username_taken" }, { status: 409 });
    }
    throw e;
  }

  // Auto-login the freshly-activated employee.
  createSession(targetId, null);
  return NextResponse.json({ ok: true });
}
