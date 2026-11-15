import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTestSheet, isAnnualCheckupInvalid, isApproverUser } from "@/lib/annual-checkup-db";
import { isUnlocked, requireClinicalUser, unlockExpiry } from "@/lib/annual-checkup-api";
import TestSheetClient from "../../../TestSheetClient";
import UnlockPanel from "../../../UnlockPanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ลงผลรายรายการ · NOKHOOK OS PORTAL" };

export default function TestSheetPage({ params }: { params: { roundId: string; code: string } }) {
  const user = requireClinicalUser();
  const roundId = Number(params.roundId);
  if (!Number.isInteger(roundId) || roundId <= 0 || !/^[A-Z0-9_]{1,20}$/.test(params.code)) notFound();
  let sheet: ReturnType<typeof getTestSheet>;
  try { sheet = getTestSheet(user, roundId, params.code); } catch (e) { if (isAnnualCheckupInvalid(e)) notFound(); throw e; }
  const approver = isApproverUser(user.id);
  return (
    <div className="space-y-4">
      <Link href={`/staff/health/annual-checkup/${roundId}`} className="text-sm text-slate-500 hover:text-brand">← กลับภาพรวมรอบ</Link>
      <h1 className="text-xl font-bold text-slate-800">{sheet.test.nameTh}</h1>
      {approver && <UnlockPanel unlockedUntil={unlockExpiry(user)} />}
      <TestSheetClient roundId={roundId} valueKind={sheet.test.valueKind} defaultUnit={sheet.test.unit} rows={sheet.rows} isApprover={approver} unlocked={isUnlocked(user)} />
    </div>
  );
}
