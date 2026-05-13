import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { listShiftCodes } from "@/lib/roster";
import ShiftCodesClient from "./ShiftCodesClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "รหัสกะ · PERSONA" };

export default function AdminShiftCodesPage() {
  const user = requireAdmin();
  const lang = getLang();
  if (!user.activeBranchId) {
    return <div className="card text-sm text-slate-600">{t(lang, "admin.notAssignedBranch")}</div>;
  }
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;

  const codes = listShiftCodes(branch.id);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/persona/roster" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "admin.persona.roster.backToRoster")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.roster.shifts.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.roster.shifts.subtitle")}
        </p>
      </div>
      <ShiftCodesClient codes={codes} />
    </div>
  );
}
