"use client";

// Error boundary for the whole admin console. A crash on any admin page (a
// stale chunk after a deploy, an expired session, a transient error) shows a
// recovery card with a "เข้าสู่ระบบ" action instead of the bare system-error
// card — so a tapped LINE shortcut into an admin menu lands on the login/PIN
// screen (owner 2026-09-24).

import SegmentErrorRecovery from "@/app/components/SegmentErrorRecovery";

export default function AdminError({
  error, reset
}: { error: Error & { digest?: string }; reset: () => void }) {
  return <SegmentErrorRecovery error={error} reset={reset} />;
}
