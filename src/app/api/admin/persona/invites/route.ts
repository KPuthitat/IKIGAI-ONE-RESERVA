import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction, type UserRole } from "@/lib/db";
import { createInvite, revokeOpenInvites } from "@/lib/invites";

// POST /api/admin/persona/invites
//
// Two modes via `kind`:
//   onboard  — creates a brand-new user row + an onboarding invite.
//              body needs display_name + branch_id + role + (optional)
//              employment_type / job_title. The new user is parked
//              in status='pending_invite' with a placeholder hash —
//              they can't log in until they redeem the invite.
//   reset    — re-issues an invite for an existing user_id so they
//              can set new credentials.
//   rebind_line — same idea but for LINE re-binding.

const Body = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("onboard"),
    display_name: z.string().trim().min(1).max(120),
    branch_id: z.number().int().positive(),
    role: z.enum(["staff", "admin"]),  // super_admin only assignable via super_admin endpoint
    employment_type: z.enum(["pt", "ft"]).optional(),
    job_title: z.string().max(120).optional(),
    employee_code: z.string().max(40).optional()
  }),
  z.object({
    kind: z.literal("reset"),
    user_id: z.number().int().positive()
  }),
  z.object({
    kind: z.literal("rebind_line"),
    user_id: z.number().int().positive()
  })
]);

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json(
    { error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 }
  );
  const d = parsed.data;
  const db = getDb();

  // Only super_admin can assign role='admin'. Plain admins create staff.
  if (d.kind === "onboard" && d.role === "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "super_admin_required_for_admin_role" }, { status: 403 });
  }

  let userId: number;

  if (d.kind === "onboard") {
    // Username placeholder = invite.<random>; staff sets the real
    // username on redemption. Password hash is a non-functional
    // sentinel ("!" prefix) so even if someone races a login they
    // can't match it.
    const placeholderUsername = `invite.${Math.random().toString(36).slice(2, 10)}`;
    const placeholderHash = `!pending!${bcrypt.hashSync(crypto.randomUUID(), 4)}`;
    try {
      const r = db.prepare(`
        INSERT INTO users
          (username, password_hash, display_name, role, status,
           employment_type, job_title, employee_code)
        VALUES (?, ?, ?, ?, 'pending_invite', ?, ?, ?)
      `).run(
        placeholderUsername, placeholderHash, d.display_name.trim(), d.role as UserRole,
        d.employment_type ?? null, d.job_title ?? null, d.employee_code ?? null
      );
      userId = Number(r.lastInsertRowid);
      // Link to the requested branch via user_branches. An admin onboard
      // also gets is_admin=1 on that branch — otherwise role='admin' with
      // zero admin-branches makes requireAdmin treat them as staff and the
      // sidebar's view-switch never appears (bug fixed 2026-06-03). Mirrors
      // what the branch-admin grant route does.
      db.prepare(
        "INSERT INTO user_branches (user_id, branch_id, is_admin) VALUES (?, ?, ?)"
      ).run(userId, d.branch_id, d.role === "admin" ? 1 : 0);
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        return NextResponse.json({ error: "duplicate_user" }, { status: 409 });
      }
      throw e;
    }
  } else {
    // reset / rebind_line — verify the user exists. Revoke any open
    // invites first so the staff only has one valid link at a time.
    const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(d.user_id);
    if (!exists) return NextResponse.json({ error: "user_not_found" }, { status: 404 });
    revokeOpenInvites(d.user_id, "superseded_by_new_invite");
    userId = d.user_id;
  }

  const invite = createInvite({
    userId, kind: d.kind, createdBy: user.id
  });
  logPersonaAction(user.id, `invite.${d.kind}`, invite.id);

  // Build redemption URLs the admin can paste into LINE chat.
  //
  //   liff_url    — wrapped via liff.line.me. When the staff taps
  //                 this in LINE, the app intercepts, runs the LIFF
  //                 SDK, captures their LINE userId, and forwards
  //                 to /persona/invite/<token>. This is the URL
  //                 admin SHOULD share by default.
  //
  //   direct_url  — plain /persona/invite/<token>. Falls back when LIFF
  //                 isn't configured, or when the staff has lost
  //                 their LINE account and needs to redeem in a
  //                 desktop browser. Doesn't auto-bind LINE userId
  //                 (admin will need to paste it after the fact).
  const base = (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const directUrl = `${base}/persona/invite/${invite.token}`;
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID_INVITE;
  const liffUrl = liffId
    ? `https://liff.line.me/${liffId}?token=${invite.token}`
    : null;

  return NextResponse.json({
    ok: true,
    invite_id: invite.id,
    user_id: userId,
    token: invite.token,
    expires_at: invite.expires_at,
    // `url` retained for callers that expect a single field; prefer
    // liff_url when available since it auto-binds LINE.
    url: liffUrl ?? directUrl,
    liff_url: liffUrl,
    direct_url: directUrl
  });
}
