"use client";

// Error boundary for the staff area — same recovery as admin so a tapped
// clock-in / approval shortcut that hits an expired session or a stale chunk
// lands on the login screen, not a dead system-error card (owner 2026-09-24).

import SegmentErrorRecovery from "@/app/components/SegmentErrorRecovery";

export default function StaffError({
  error, reset
}: { error: Error & { digest?: string }; reset: () => void }) {
  return <SegmentErrorRecovery error={error} reset={reset} />;
}
