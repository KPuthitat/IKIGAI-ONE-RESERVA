// One-tap "Login with LINE" (owner 2026-07-02).
//
// Uses a LINE Login channel (OAuth 2.1) that MUST sit under the SAME LINE
// provider as the Messaging API / OA channel — only then does the userId
// returned here match the users.line_user_id we already store, so we can
// map the LINE identity to an employee row. No account is auto-created:
// login only succeeds for a LINE already bound to an employee by an admin.
//
// Config is env-gated (LINE_LOGIN_CHANNEL_ID + _SECRET). When unset the
// login page hides the button and /api/auth/line/* short-circuit, so the
// feature ships dark until the owner sets it up.

const AUTHORIZE_URL = "https://access.line.me/oauth2/v2.1/authorize";
const TOKEN_URL = "https://api.line.me/oauth2/v2.1/token";
const PROFILE_URL = "https://api.line.me/v2/profile";

export function lineLoginConfigured(): boolean {
  return Boolean(process.env.LINE_LOGIN_CHANNEL_ID && process.env.LINE_LOGIN_CHANNEL_SECRET);
}

/** Absolute base URL for building the OAuth redirect_uri. Must match the
 *  Callback URL registered in the LINE Login channel EXACTLY, so we key
 *  off the same public-base env the invite links use. */
export function publicBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");
}

export function lineCallbackUri(): string {
  return `${publicBaseUrl()}/api/auth/line/callback`;
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.LINE_LOGIN_CHANNEL_ID as string,
    redirect_uri: lineCallbackUri(),
    state,
    scope: "openid profile"
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchange the authorization code for the caller's LINE userId. Returns
 *  null on any failure (bad code, network, unexpected shape) so callers
 *  bounce back to the login page with a generic error. */
export async function exchangeCodeForLineUserId(code: string): Promise<string | null> {
  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: lineCallbackUri(),
        client_id: process.env.LINE_LOGIN_CHANNEL_ID as string,
        client_secret: process.env.LINE_LOGIN_CHANNEL_SECRET as string
      })
    });
    if (!tokenRes.ok) return null;
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) return null;

    const profRes = await fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (!profRes.ok) return null;
    const prof = (await profRes.json()) as { userId?: string };
    return prof.userId ?? null;
  } catch {
    return null;
  }
}
