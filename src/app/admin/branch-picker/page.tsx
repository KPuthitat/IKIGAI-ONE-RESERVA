// /admin/branch-picker — admin-side mirror of /staff/branch-picker.
//
// Reached via the topbar "เปลี่ยน" link in admin layout. Handles 0/1/many
// branches identically to the staff picker (auto-skip + redirect on
// 1 branch, polite error on 0). Admin reuses the BranchPickerClient
// component so visuals stay consistent.

import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireAdmin, setActiveBranch } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import BranchPickerClient from "../../BranchPickerClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เลือกสาขา · Admin" };

export default function AdminBranchPickerPage({
  searchParams
}: { searchParams: { next?: string } }) {
  const user = requireAdmin();
  const lang = getLang();
  const next = searchParams.next || "/admin";

  // Admin console only operates on branches the user may administer:
  // super_admin → all their member branches; sub-admin → branches
  // granted via user_branches.is_admin. Branches where they are only
  // staff are hidden here (they appear in the staff picker instead).
  const adminBranches = user.branches.filter((b) =>
    user.adminBranchIds.includes(b.id)
  );

  if (adminBranches.length === 0) {
    return (
      <div className="card text-center space-y-3">
        <h1 className="text-xl font-bold text-slate-800">
          {t(lang, "staff.branchPicker.empty.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "staff.branchPicker.empty.body")}
        </p>
      </div>
    );
  }

  if (adminBranches.length === 1) {
    setActiveBranch(adminBranches[0].id);
    redirect(next);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "staff.branchPicker.title")}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "staff.branchPicker.subtitle", { name: user.display_name })}
        </p>
      </div>
      <BranchPickerClient
        branches={adminBranches.map((b) => ({ id: b.id, name: b.name }))}
        activeBranchId={user.activeBranchId}
        next={next}
      />
    </div>
  );
}
