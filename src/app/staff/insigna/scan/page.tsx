// /staff/insigna/scan — checkout: scan the customer's member QR (or type the
// member code), then type the bill number from the POS. The bill is tied to
// the member at once if the day's receipt file is already imported, otherwise
// it waits and resolves on import. Staff see only the member code, never a name.
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import ScanClient from "./ScanClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สแกนบัตรสมาชิก · INSIGNA" };

export default function StaffMemberScanPage() {
  const user = requireUser();
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-slate-800">สแกนบัตรสมาชิก</h1>
        <div className="card text-sm text-slate-500">
          กรุณาเลือกสาขาก่อน แล้วเปิดหน้านี้อีกครั้ง —{" "}
          <Link href="/staff/branch-picker?next=%2Fstaff%2Finsigna%2Fscan" className="text-brand hover:underline">เลือกสาขา</Link>
        </div>
      </div>
    );
  }
  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <h1 className="text-xl font-bold text-slate-800">สแกนบัตรสมาชิก</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          ตอนชำระเงิน สแกน QR บนบัตรสมาชิกในแชท LINE ของลูกค้า (หรือพิมพ์หมายเลขสมาชิก 8 หลัก) แล้วกรอกเลขที่บิลจาก POS · สาขา {branch?.name ?? `#${branchId}`}
        </p>
      </div>
      <ScanClient today={today} />
    </div>
  );
}
