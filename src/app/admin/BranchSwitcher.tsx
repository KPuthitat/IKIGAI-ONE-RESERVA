"use client";
import { useRouter } from "next/navigation";
import type { Branch } from "@/lib/db";
import { apiUrl } from "@/lib/url";

export default function BranchSwitcher({
  branches, activeBranchId
}: { branches: Branch[]; activeBranchId: number | null }) {
  const router = useRouter();
  if (branches.length <= 1) {
    return <span className="text-sm text-slate-600">{branches[0]?.name ?? "—"}</span>;
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
      className="border border-slate-300 rounded-md px-2 py-1 text-sm"
    >
      {branches.map((b) => (
        <option key={b.id} value={b.id}>{b.name}</option>
      ))}
    </select>
  );
}
