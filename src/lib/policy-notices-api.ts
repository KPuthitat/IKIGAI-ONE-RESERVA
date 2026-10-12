// Shared helpers for the policy-notice admin routes (Next route files may only export handlers).
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isAdminCapable } from "./auth";
import { PolicyError, POLICY_ERROR_TH } from "./policy-notices";

export function adminGate() {
  const user = getSessionUser();
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) } as const;
  if (!isAdminCapable(user)) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as const;
  return { user } as const;
}

export const NoticeBody = z.object({
  title: z.string().trim().min(1).max(200),
  purpose: z.string().max(1000).optional(),
  meeting_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullable().optional(),
  location: z.string().max(200).optional(),
  branch_id: z.number().int().positive().nullable().optional(),
  ack_deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
});

export function errorResponse(e: unknown) {
  if (e instanceof PolicyError) {
    const status = e.code === "not_found" ? 404 : e.code === "locked" || e.code === "bad_status" ? 409 : 400;
    return NextResponse.json({ error: e.code, message: POLICY_ERROR_TH[e.code] }, { status });
  }
  throw e;
}

