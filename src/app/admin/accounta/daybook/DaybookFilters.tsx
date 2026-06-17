"use client";

import { useRouter } from "next/navigation";

type Ref = { id: number; name: string };

// Filter bar for the daybook — pushes branch/company/month into the URL
// query so the server page re-renders with the new scope.
export default function DaybookFilters({
  month, branchId, companyId, branches, companies
}: {
  month: string; branchId: string; companyId: string; branches: Ref[]; companies: Ref[];
}) {
  const router = useRouter();
  const go = (next: Record<string, string>) => {
    const q = new URLSearchParams({ month, branch: branchId, company: companyId, ...next });
    for (const [k, v] of [...q.entries()]) if (!v) q.delete(k);
    router.push(`/admin/accounta/daybook?${q.toString()}`);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input type="month" className="input !w-auto" value={month}
        onChange={(e) => go({ month: e.target.value })} />
      <select className="input !w-auto" value={companyId} onChange={(e) => go({ company: e.target.value })}>
        <option value="">ทุกบริษัท</option>
        {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select className="input !w-auto" value={branchId} onChange={(e) => go({ branch: e.target.value })}>
        <option value="">ทุกสาขา</option>
        {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </div>
  );
}
