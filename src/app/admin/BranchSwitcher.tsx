"use client";
import { useRouter } from "next/navigation";
import type { Branch } from "@/lib/db";
import { apiUrl } from "@/lib/url";

// Shared branch switcher — used by both PERSONA and RESERVA admin
// layouts. Writes to the session via /api/admin/branch and refreshes
// the route so server components re-query with the new activeBranchId.
//
// Single-branch admins see a static label (no point in a dropdown of
// one option).
export default function BranchSwitcher({
  branches, activeBranchId
}: { branches: Branch[]; activeBranchId: number | null }) {
  const router = useRouter();
  if (branches.length <= 1) {
    return <span className="text-sm text-slate-600 ml-1">{branches[0]?.name ?? "—"}</span>;
  }
  return (
    <select
      value={activeBranchId ?? ""}
      onChange={async (e) => {
        const id = Number(e.target.value);
        await fetch(apiUrl("/api/admin/branch"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ branch_id: id })
        });
        router.refresh();
      }}
      className="border border-slate-300 bg-white rounded-md px-2 py-1 text-sm focus:outline-none focus:border-brand"
    >
      {branches.map((b) => (
        <option key={b.id} value={b.id}>{b.name}</option>
      ))}
    </select>
  );
}
