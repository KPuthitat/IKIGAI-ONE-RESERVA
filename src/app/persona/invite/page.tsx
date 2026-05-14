// /persona/invite — public LIFF endpoint URL for the Staff Invite
// flow. Lives under /persona/ to make the URL self-describe its
// domain (staff onboarding belongs to the PERSONA module, not to
// RESERVA which is customer bookings).
//
// Why a redirect bridge instead of putting LIFF directly on
// /persona/invite/[token]: LINE Developers Console requires LIFF
// endpoints to be a STATIC URL — we can't register a URL with a
// [token] path param. So the LIFF app's endpoint URL is this page,
// which:
//
//   1. Reads ?token=<x> from its own URL (LIFF preserves query
//      params when forwarding from liff.line.me/<liffId>?token=<x>)
//   2. Loads the LIFF SDK + calls liff.init().
//   3. If logged into LINE (in-LINE or after the auto-redirect),
//      pulls the user's profile (userId + displayName).
//   4. Stashes them in sessionStorage so the redemption page can
//      pick them up.
//   5. Hard-redirects to /persona/invite/<token> where the rest of
//      the onboarding form lives.
//
// If the page is opened outside LINE (e.g. someone forwards the
// URL to a desktop browser), LIFF either:
//   • redirects to a LINE login page (with `liff.login()` called
//     inside init's flow) — we just wait, then continue, or
//   • init throws — we skip LINE binding and just forward to the
//     manual form. The staff can still redeem; admin will have to
//     paste their userId later.

import Script from "next/script";
import RedirectClient from "./RedirectClient";

export const dynamic = "force-dynamic";

export default function InviteRedirectPage() {
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID_INVITE ?? "";
  return (
    <>
      <Script
        src="https://static.line-scdn.net/liff/edge/2/sdk.js"
        strategy="beforeInteractive"
      />
      <RedirectClient liffId={liffId} />
    </>
  );
}
