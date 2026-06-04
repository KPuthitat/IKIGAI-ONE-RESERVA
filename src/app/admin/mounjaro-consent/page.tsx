import Link from "next/link";
import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth";
import { getActiveConsent } from "@/lib/mounjaro-db";
import ConsentEditorClient from "./ConsentEditorClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ข้อความยินยอม Mounjaro · IKIGAI OS" };

// /admin/mounjaro-consent — super_admin edits the PDPA consent text shown
// to employees before they join the Mounjaro program.
export default function MounjaroConsentPage() {
  requireSuperAdmin();
  const active = getActiveConsent();

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <Link href="/admin" className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ข้อความยินยอม (PDPA) — โครงการ Mounjaro</h1>
        <p className="text-sm text-slate-500 mt-1">
          ข้อความนี้แสดงให้พนักงานอ่านและกดยินยอมก่อนเข้าร่วมโครงการ
          เวอร์ชันปัจจุบัน: <b>{active?.version ?? "—"}</b>
        </p>
      </div>
      <ConsentEditorClient initialBody={active?.body ?? ""} version={active?.version ?? null} />
    </div>
  );
}
