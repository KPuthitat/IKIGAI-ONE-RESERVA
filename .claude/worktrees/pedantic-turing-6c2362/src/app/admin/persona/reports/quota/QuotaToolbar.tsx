"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import type { StaffOpt } from "../ReportToolbar";

function downloadCsv(filename: string, csv: string): void {
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

export default function QuotaToolbar({
  lang, year, userId, staffList, csv, csvFilename, yearOptions
}: {
  lang: Lang;
  year: number;
  userId: number | null;
  staffList: StaffOpt[];
  csv: string;
  csvFilename: string;
  yearOptions: number[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: string, value: string | null): void {
    const sp = new URLSearchParams(params.toString());
    if (value === null || value === "") sp.delete(key);
    else sp.set(key, value);
    startTransition(() => router.push(`${pathname}?${sp.toString()}`));
  }

  return (
    <div className="card flex flex-wrap items-end gap-3">
      <div>
        <label className="block text-xs text-slate-500 mb-1">
          {t(lang, "admin.persona.reports.filter.year")}
        </label>
        <select
          value={year}
          onChange={(e) => setParam("year", e.target.value)}
          className="input text-sm"
          disabled={pending}
        >
          {yearOptions.map((y) => (
            <option key={y} value={y}>
              {lang === "th" ? `${y + 543} (${y})` : y}
            </option>
          ))}
        </select>
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
