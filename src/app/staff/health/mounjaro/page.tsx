import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { hasAdminPin } from "@/lib/admin-pin";
import {
  getMyEnrollment, getMyClinical, getMySelfLogs, getActiveConsent,
  getMyAuditTrail, type MjActor
} from "@/lib/mounjaro-db";
import MounjaroSelfClient from "./MounjaroSelfClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "โครงการ Mounjaro · IKIGAI OS PORTAL" };

// Employee self-service for the Mounjaro Wellness program. All data comes
// through the gateway scoped to the logged-in employee (their own rows
// only). The menu only links here when an enrollment exists, but the page
// also renders the NO_ENROLLMENT state for the home-banner entry point.
function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string") return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export default function MounjaroSelfPage() {
  const user = requireUser();
  const actor = user as MjActor;
  const enr = getMyEnrollment(actor);
  const clinical = enr ? getMyClinical(actor) : { patient: null, visits: [] };
  const selfLogs = enr ? getMySelfLogs(actor) : [];

  const p = clinical.patient;
  const baseline = parseJson<Record<string, number>>(p?.baseline_json, {});

  const enrollment = enr
    ? {
        status: enr.status as "pending" | "active" | "withdrawn" | "completed",
        enrolled_at: enr.enrolled_at,
        withdrawn_reason: enr.withdrawn_reason
      }
    : null;

  const patient = p
    ? {
        hn: (p.hn as string | null) ?? null,
        start_date: (p.start_date as string | null) ?? null,
        notes: (p.notes as string | null) ?? null,
        baseline
      }
    : null;

  const visits = clinical.visits.map((v) => ({
    date: (v.date as string | null) ?? null,
    dose: (v.dose as number | null) ?? null,
    weight: (v.weight as number | null) ?? null,
    next_visit: (v.next_visit as string | null) ?? null
  }));

  const logs = selfLogs.map((l) => ({
    date: (l.date as string | null) ?? null,
    weight: (l.weight as number | null) ?? null,
    injection_done: (l.injection_done as number | null) === 1,
    bp: (l.bp as string | null) ?? null,
    hr: (l.hr as number | null) ?? null,
    fbs: (l.fbs as number | null) ?? null,
    diary: (l.diary as string | null) ?? null,
    doctor_reply: (l.doctor_reply as string | null) ?? null
  }));

  // Consent — re-consent required when the active version differs from
  // what the employee last signed (or never signed).
  const activeConsent = getActiveConsent();
  const needsConsent = !!(enr && enr.status === "active" && activeConsent
    && enr.consent_version !== activeConsent.version);

  const audit = enr
    ? getMyAuditTrail(actor).map((a) => ({
        action: String(a.action ?? ""),
        by_name: (a.by_name as string | null) ?? null,
        created_at: String(a.created_at ?? "")
      }))
    : [];

  return (
    <MounjaroSelfClient
      enrollment={enrollment}
      patient={patient}
      visits={visits}
      selfLogs={logs}
      consent={{ needed: needsConsent, version: activeConsent?.version ?? null, body: activeConsent?.body ?? null }}
      audit={audit}
      hasPin={hasAdminPin(user.id)}
    />
  );
}
