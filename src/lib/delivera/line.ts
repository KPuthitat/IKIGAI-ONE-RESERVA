import { sendLinePush, type LineMessage } from "@/lib/line";

// DELIVERA uses TWO LINE channels, kept strictly separate from the staff OA:
//   • customer channel — LIFF ordering + order-status pushes
//   • rider channel    — rider LIFF + new-job pushes
// Tokens come from env (not the DB platform channel, which is the staff OA).

const PROFILE_URL = "https://api.line.me/v2/profile";

/** Resolve a LIFF access token to the caller's LINE identity via the Profile
 *  API. The token is channel-scoped, so this identifies the user within the
 *  channel the LIFF belongs to. Returns null on any failure.
 *  ASSUMPTION: profile-scoping is sufficient identity proof for a dark-shipped
 *  module; a stricter /oauth2/v2.1/verify client_id match can be added once the
 *  channel id is provisioned in env. */
export async function verifyAccessToken(accessToken: string): Promise<{ userId: string; displayName: string } | null> {
  if (!accessToken) return null;
  try {
    const r = await fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return null;
    const p = (await r.json()) as { userId?: string; displayName?: string };
    return p.userId ? { userId: p.userId, displayName: p.displayName ?? "" } : null;
  } catch {
    return null;
  }
}

type PushResult = { ok: boolean; status: number; error?: string };

export async function pushCustomer(userId: string, messages: LineMessage[]): Promise<PushResult> {
  const token = process.env.LINE_CUSTOMER_CHANNEL_ACCESS_TOKEN;
  if (!token) return { ok: false, status: 0, error: "customer_channel_unconfigured" };
  return sendLinePush(token, { to: userId, messages });
}

export async function pushRider(userId: string, messages: LineMessage[]): Promise<PushResult> {
  const token = process.env.LINE_RIDER_CHANNEL_ACCESS_TOKEN;
  if (!token) return { ok: false, status: 0, error: "rider_channel_unconfigured" };
  return sendLinePush(token, { to: userId, messages });
}
