// /admin/persona/approval-chain — configure the branch's 2-tier
// approval chain (supervisors + executives) used by leave +
// resignation flows. Owner direction (2026-05): replaces the per-
// user reports_to_user_id chain with a branch-scoped config so the
// flow stays consistent even when staff turnover happens.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin, getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getBranchTierMembers, type TierMember } from "@/lib/approval-tiers";
import ApprovalChainClient, { type EligibleUser } from "./ApprovalChainClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "สายบังคับบัญชา · PERSONA" };

export default function ApprovalChainPage() {
  requireAdmin();
  const user = getSessionUser();
  // requireAdmin() above throws on null but TS doesn't know that.
  if (!user || !user.activeBranchId) {
    return (
      <div className="card text-sm text-amber-700">
        เลือกสาขาที่ต้องการตั้งสายบังคับบัญชาก่อน
      </div>
    );
  }
  const branchId = user.activeBranchId;
  const db = getDb();

  // Branch name for the page header.
  const branch = db.prepare(
    "SELECT name FROM branches WHERE id = ?"
  ).get(branchId) as { name: string } | undefined;

  // Current members of each tier (active users only — disabled users
  // are filtered out by getBranchTierMembers).
  const tier1: TierMember[] = getBranchTierMembers(branchId, 1);
  const tier2: TierMember[] = getBranchTierMembers(branchId, 2);

  // Pool of eligible users for the multi-select — all active
  // staff/admin assigned to THIS branch. super_admins are included
  // too since they can also serve as approvers (and often do at
  // small clinics where the owner is super_admin).
  const eligible = db.prepare(`
    SELECT DISTINCT u.id, u.display_name, u.title_prefix, u.nickname_th, u.role
    FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.status != 'disabled'
      AND u.role IN ('staff', 'admin', 'super_admin')
    ORDER BY u.display_name
  `).all(branchId) as EligibleUser[];

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          สายบังคับบัญชา
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          ตั้งหัวหน้างาน (อนุมัติชั้นต้น) และผู้บริหาร (อนุมัติชั้นสุดท้าย) ของสาขา{" "}
          <span className="font-semibold text-slate-700">{branch?.name ?? "—"}</span>
        </p>
      </div>
      <ApprovalChainClient
        branchId={branchId}
        branchName={branch?.name ?? ""}
        eligible={eligible}
        initialTier1={tier1.map((m) => m.user_id)}
        initialTier2={tier2.map((m) => m.user_id)}
      />
    </div>
  );
}
