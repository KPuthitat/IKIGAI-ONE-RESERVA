"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

/** Close the clinic window now (otherwise it closes by itself after 20 minutes). */
export default function ClinicLock() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function lock() {
    setBusy(true);
    try { await fetch(apiUrl("/api/annual-checkup/clinic/pin"), { method: "DELETE" }); } finally { setBusy(false); }
    router.replace("/staff/health/annual-checkup/pin"); router.refresh();
  }
  return <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={lock}>ล็อกส่วนคลินิก</button>;
}
