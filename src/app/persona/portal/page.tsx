// /persona/portal — public LIFF endpoint for the daily-use Staff Portal
// rich-menu link. Lives under /persona/ for the same semantic reason as
// /persona/invite (staff-facing, PERSONA module).
//
// Distinct from /persona/invite because:
//   • /persona/invite is for FIRST-TIME registration — admin sends a
//     one-time token link via 1:1 LINE chat.
//   • /persona/portal is for DAILY USE — staff taps the OA rich menu,
//     we read their LINE userId via LIFF, look it up in users.line_user_id,
//     and create a session. No token, no form. Zero typing.
//
// Falls back to /login (manual username+password) if:
//   • LIFF can't init (e.g. external browser, no LINE login)
//   • The LINE account isn't bound to any user yet (e.g. someone tries
//     to use the link before HR has onboarded them via /persona/invite)

import Script from "next/script";
import PortalClient from "./PortalClient";

export const dynamic = "force-dynamic";

export const metadata = { title: "เข้าระบบ · IKIGAI OS" };

export default function PortalEntryPage() {
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID_PORTAL ?? "";
  return (
    <>
      <Script
        src="https://static.line-scdn.net/liff/edge/2/sdk.js"
        strategy="beforeInteractive"
      />
      <PortalClient liffId={liffId} />
    </>
  );
}
