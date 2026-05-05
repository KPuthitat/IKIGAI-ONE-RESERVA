"use client";
import { useRouter } from "next/navigation";
import type { Branch } from "@/lib/db";
import { apiUrl } from "@/lib/url";

export default function BranchSwitcher({
  branches, activeBranchId
}: { branches: Branch[]; activeBranchId: number | null }) {
  const router = useRouter();
  if (branches.length <= 1) {
    return <span className="text-sm text-white/80">{branches[0]?.name ?? "—"}</span>;
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
      className="bg-white/10 border border-white/20 text-white rounded-md px-2 py-1 text-sm focus:outline-none focus:border-white/50"
    >
      {branches.map((b) => (
        <option key={b.id} value={b.id} className="text-slate-800">{b.name}</option>
      ))}
    </select>
  );
}
