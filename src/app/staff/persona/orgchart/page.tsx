import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { buildAutoOrgChart } from "@/lib/org-structure";
import Client, { type StaffChart } from "./Client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ผังองค์กร · PERSONA" };

// Staff view of the organisation chart (owner 2026-10-11): so everyone can see which line they
// are in, who they report to and whom they look after. Read-only; only names, nicknames, job
// titles and the department (ฝ่าย) are shown — nothing about pay, leave or performance.
export default function StaffOrgChartPage({ searchParams }: { searchParams: { branch?: string } }) {
  const user = requireUser();
  const charts: StaffChart[] = user.branches.map((b) => {
    const a = buildAutoOrgChart(b.id);
    const mine = a.placements.find((p) => p.userId === user.id) ?? null;
    const byId = new Map(a.placements.map((p) => [p.nodeId, p]));
    const bosses = mine ? mine.parentNodeIds.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p) : [];
    const reports = mine ? a.placements.filter((p) => p.parentNodeIds.includes(mine.nodeId)) : [];
    const lite = (p: (typeof a.placements)[number]) => ({ userId: p.userId, displayName: p.displayName, titlePrefix: p.titlePrefix, nickname: p.nickname, jobTitle: p.jobTitle, department: p.department });
    return {
      branchId: b.id, branchName: b.name,
      placements: a.placements.map((p) => ({ ...lite(p), nodeId: p.nodeId, parentNodeIds: p.parentNodeIds, sortOrder: p.sortOrder, role: p.role })),
      onChart: !!mine,
      bosses: bosses.map(lite), reports: reports.map(lite)
    };
  });
  const wanted = Number(searchParams.branch);
  const first = charts.find((c) => c.branchId === wanted)?.branchId ?? charts.find((c) => c.branchId === user.activeBranchId)?.branchId ?? charts[0]?.branchId ?? null;
  return <Client meId={user.id} charts={charts} initialBranchId={first} />;
}
