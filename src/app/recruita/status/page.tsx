import type { Metadata } from "next";
import { getRecruitaChannel } from "@/lib/messaging-channels";
import StatusClient from "./StatusClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "เช็คสถานะใบสมัคร · IKIGAI Recruit" };

// /recruita/status — public-facing status page reached from the
// IKIGAI Recruit OA rich menu (ปุ่ม "เช็คสถานะ"). Server reads the
// LIFF id of the RECRUITA channel; the client uses it to init LIFF,
// pull the candidate's line_user_id, and ask the API which
// applications belong to them. Renders one card per application
// with the current stage chip + branch + position title.
//
// If LIFF isn't configured yet, we still render — the client falls
// back to a "open in LINE app" message instead of crashing.

export default function StatusPage() {
  const channel = getRecruitaChannel();
  // Prefer the status-specific LIFF id (different endpoint URL),
  // fall back to the shared liff_id when only one is configured.
  // Both must be under the same LINE Login channel so getProfile()
  // returns the same userId regardless of which one launched the page.
  const liffId = channel?.liff_id_status || channel?.liff_id || null;
  return <StatusClient liffId={liffId} />;
}
