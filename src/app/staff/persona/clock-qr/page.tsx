import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import ClockQrClient from "./ClockQrClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PERSONA · QR ลงเวลา (จอหน้าร้าน)" };

// Door-display page (owner 2026-07-14). Meant to be left open full-screen on a
// tablet/old phone at the branch entrance. Shows a QR that rotates every 30s;
// staff scan it from the normal ลงเวลา screen to clock in. Only works when the
// branch has rotating QR enabled (clock_totp_secret set).
export default function ClockQrDisplayPage() {
  const user = requireUser();
  const db = getDb();
  const branch = user.activeBranchId
    ? (db.prepare("SELECT * FROM branches WHERE id = ?")
        .get(user.activeBranchId) as Branch | undefined)
    : undefined;

  if (!branch) {
    return (
      <div className="p-6 text-center text-slate-600">
        ยังไม่ได้เลือกสาขา — เลือกสาขาก่อนเปิดจอ QR
      </div>
    );
  }
  if (!branch.clock_totp_secret) {
    return (
      <div className="p-6 max-w-md mx-auto text-center space-y-3">
        <p className="text-slate-700 font-medium">
          สาขา {branch.name} ยังไม่ได้เปิด &ldquo;QR หมุนรหัส&rdquo;
        </p>
        <p className="text-sm text-slate-500">
          ให้ผู้ดูแลเปิดที่หน้า ตั้งค่าสาขา → ระบบลงเวลา ก่อน แล้วค่อยเปิดจอนี้
        </p>
        <Link href="/staff/persona" className="text-brand hover:underline text-sm">
          ← กลับหน้าลงเวลา
        </Link>
      </div>
    );
  }

  return <ClockQrClient branchName={branch.name} />;
}
