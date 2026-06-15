import { redirect } from "next/navigation";

// /recruita — landing page for the RECRUITA apply LIFF. The LIFF app's
// Endpoint URL is set to https://<host>/recruita (owner 2026-06-15) so the
// WHOLE candidate flow — /recruita/positions, /recruita/apply/[id],
// /recruita/status — lives UNDER the endpoint and therefore stays inside the
// LIFF session (liff.isLoggedIn() === true on every page). That's what lets
// the apply page capture the LINE userId directly instead of the apply page
// being treated as "outside" the LIFF and breaking liff.login() with a 400.
//
// The LIFF launcher opens this URL; we just forward to the positions list,
// which is the real entry point of the apply flow.
export const dynamic = "force-dynamic";

export default function RecruitaIndexPage() {
  redirect("/recruita/positions");
}
