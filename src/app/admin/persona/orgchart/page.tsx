import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  listCompanyBranchesForOrg, listBranchOrgPlacements, listBranchOrgCandidates, listBranchDepartments
} from "@/lib/org-chart";
import OrgChartClient, { type OrgBranchData } from "./OrgChartClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ผังองค์กร · PERSONA" };

export default function OrgChartPage() {
  const user = requirePermission("persona.manage");
  if (!user.activeBranchId) {
    return <div className="card text-sm text-slate-600">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน</div>;
  }
  const db = getDb();
  const branch = db.prepare("SELECT company_id FROM branches WHERE id = ?")
    .get(user.activeBranchId) as { company_id: number | null } | undefined;
  const companyId = branch?.company_id ?? null;
  const company = companyId != null
    ? (db.prepare("SELECT name_th FROM companies WHERE id = ?").get(companyId) as { name_th: string } | undefined)
    : undefined;

  const branchList = companyId != null
    ? listCompanyBranchesForOrg(companyId)
    : (db.prepare("SELECT id, name FROM branches WHERE id = ?").all(user.activeBranchId) as Array<{ id: number; name: string }>);

  const branches: OrgBranchData[] = branchList.map((b) => ({
    id: b.id,
    name: b.name,
    placements: listBranchOrgPlacements(b.id),
    candidates: listBranchOrgCandidates(b.id),
    departments: listBranchDepartments(b.id)
  }));

  return (
    <OrgChartClient
      companyName={company?.name_th ?? null}
      activeBranchId={user.activeBranchId}
      branches={branches}
    />
  );
}
