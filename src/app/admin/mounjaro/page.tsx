import type { Metadata } from "next";
import { requireClinicalDoctor, isClinicalUnlocked } from "@/lib/auth";
import { listMyPatientsEnriched, listPendingIntake, type MjActor } from "@/lib/mounjaro-db";
import ClinicalClient from "./ClinicalClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Mounjaro · คลินิก" };

// Clinical dashboard — doctors only (their own patients). Locked until the
// doctor enters their license number this session.
export default function ClinicalListPage() {
  const user = requireClinicalDoctor();
  if (!isClinicalUnlocked(user)) {
    return <ClinicalClient mode="locked" patients={[]} pending={[]} />;
  }
  const patients = listMyPatientsEnriched(user as MjActor);
  const pending = listPendingIntake(user as MjActor);
  return <ClinicalClient mode="list" patients={patients} pending={pending} />;
}
