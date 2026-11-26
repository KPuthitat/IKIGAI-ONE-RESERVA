import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canModule } from "@/lib/auth";
import FundingClient from "./FundingClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · เงินโอนระหว่างบัญชี" };

export default function FundingPage() {
  const user = requireUser();
  if (!canModule(user, "accounta.manage")) redirect("/admin");
  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/memos" className="text-sm text-slate-500 hover:text-brand">← Memo ขอซื้อ · ลงนาม</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-1">เงินโอนระหว่างบัญชี</h1>
        <p className="text-sm text-slate-500">คำขอเบิกเงินรายสัปดาห์ — Memo ขอเบิกเงินที่ลงนามครบแล้วจะมารอที่นี่ — โอนที่ธนาคารแล้วกลับมาบันทึกวันที่และยอดจริง (ใส่ PIN) หรือรอให้ระบบจับคู่เองจากการกระทบยอด statement</p>
      </div>
      <FundingClient />
    </div>
  );
}
