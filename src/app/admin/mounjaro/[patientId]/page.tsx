import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireClinicalDoctor, isClinicalUnlocked } from "@/lib/auth";
import { getPatientBundle, patientAlerts, getPendingActionForPatient, type MjActor } from "@/lib/mounjaro-db";
import PatientDetailClient from "./PatientDetailClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ผู้ป่วย Mounjaro · คลินิก" };

function pj<T>(s: unknown, fb: T): T {
  if (typeof s !== "string") return fb;
  try { return JSON.parse(s) as T; } catch { return fb; }
}

export default function PatientDetailPage({ params }: { params: { patientId: string } }) {
  const user = requireClinicalDoctor();
  if (!isClinicalUnlocked(user)) redirect("/admin/mounjaro");
  const id = Number(params.patientId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const bundle = getPatientBundle(user as MjActor, id);
  if (!bundle) notFound(); // not the attending doctor → 404, no existence leak

  const p = bundle.patient;
  const alerts = patientAlerts(p, bundle.visits);
  const pendingAction = getPendingActionForPatient(user as MjActor, id);

  return (
    <PatientDetailClient
      patientId={id}
      pendingAction={pendingAction}
      employeeName={bundle.employeeName}
      hn={(p.hn as string | null) ?? null}
      startDate={(p.start_date as string | null) ?? null}
      notes={(p.notes as string | null) ?? null}
      baseline={pj<Record<string, number | string>>(p.baseline_json, {})}
      comorbidities={pj<Record<string, boolean>>(p.comorbidities_json, {})}
      contraindications={pj<Record<string, boolean>>(p.contraindications_json, {})}
      medications={pj<Record<string, boolean>>(p.medications_json, {})}
      visits={bundle.visits.map((v) => ({
        id: v.id as number,
        date: (v.date as string | null) ?? null,
        dose: (v.dose as number | null) ?? null,
        weight: (v.weight as number | null) ?? null,
        bp: (v.bp as string | null) ?? null,
        hr: (v.hr as number | null) ?? null,
        hba1c: (v.hba1c as number | null) ?? null,
        fbs: (v.fbs as number | null) ?? null,
        waist: (v.waist as number | null) ?? null,
        side_effects: pj<Record<string, number>>(v.side_effects_json, {}),
        hypo_count: (v.hypo_count as number | null) ?? null,
        adherence: (v.adherence as string | null) ?? null,
        decision: (v.decision as string | null) ?? null,
        next_visit: (v.next_visit as string | null) ?? null,
        notes: (v.notes as string | null) ?? null
      }))}
      selfLogs={bundle.selfLogs.map((l) => ({
        id: l.id as number,
        date: (l.date as string | null) ?? null,
        weight: (l.weight as number | null) ?? null,
        injection_done: (l.injection_done as number | null) === 1,
        bp: (l.bp as string | null) ?? null,
        hr: (l.hr as number | null) ?? null,
        fbs: (l.fbs as number | null) ?? null,
        diary: (l.diary as string | null) ?? null,
        notes_for_doctor: (l.notes_for_doctor as string | null) ?? null,
        doctor_reply: (l.doctor_reply as string | null) ?? null
      }))}
      alerts={alerts}
    />
  );
}
