"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";

// Trigger browser download — client only
function downloadCsv(filename: string, csv: string): void {
  // BOM for Excel UTF-8 (Thai chars render correctly)
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export type StaffOpt = { id: number; display_name: string };

export default function ReportToolbar({
  lang,
  month,        // "YYYY-MM"
  userId,       // null = all
  staffList,
  csv,          // pre-built CSV string from server
  csvFilename
}: {
  lang: Lang;
  month: string;
  userId: number | null;
  staffList: StaffOpt[];
  csv: string;
  csvFilename: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: string, value: string | null): void {
    const sp = new URLSearchParams(params.toString());
    if (value === null || value === "") sp.delete(key);
    else sp.set(key, value);
    startTransition(() => {
      router.push(`${pathname}?${sp.toString()}`);
    });
  }

  return (
    <div className="card flex flex-wrap items-end gap-3">
      <div>
        <label className="block text-xs text-slate-500 mb-1">
          {t(lang, "admin.persona.reports.filter.month")}
        </label>
        <input
          type="month"
          value={month}
          onChange={(e) => setParam("month", e.target.value)}
          className="input text-sm"
          disabled={pending}
        />
      </div>
      <div>
        <label className="block text-xs text-slate-500 mb-1">
          {t(lang, "admin.persona.reports.filter.employee")}
        </label>
        <select
          value={userId ?? ""}
          onChange={(e) => setParam("user_id", e.target.value || null)}
          className="input text-sm min-w-[200px]"
          disabled={pending}
        >
          <option value="">{t(lang, "admin.persona.reports.filter.allEmployees")}</option>
          {staffList.map((s) => (
            <option key={s.id} value={s.id}>{s.display_name}</option>
          ))}
        </select>
      </div>
      <div className="ml-auto flex items-end">
        <button
          type="button"
          className="btn-secondary text-sm"
          onClick={() => downloadCsv(csvFilename, csv)}
        >
          {t(lang, "admin.persona.reports.exportCsv")}
        </button>
      </div>
    </div>
  );
}
