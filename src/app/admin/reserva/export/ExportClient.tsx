"use client";
import { useMemo, useState } from "react";
import type { Branch } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

export default function ExportClient({ branches }: { branches: Branch[] }) {
  const { t } = useLang();
  const today = useMemo(() => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10), []);
  const monthAgo = useMemo(() => {
    const d = new Date(Date.now() + 7 * 60 * 60 * 1000);
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  }, []);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState<string>("");

  const url = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (branchId) p.set("branch_id", branchId);
    return apiUrl(`/api/admin/export?${p.toString()}`);
  }, [from, to, branchId]);

  return (
    <div className="card max-w-xl space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">{t("admin.export.field.from")}</label>
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">{t("admin.export.field.to")}</label>
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="label">{t("admin.export.field.branch")}</label>
        <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          <option value="">{t("admin.export.allBranches")}</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>
      <a href={url} className="btn-primary inline-flex" download>
        {t("admin.export.download")}
      </a>
    </div>
  );
}
