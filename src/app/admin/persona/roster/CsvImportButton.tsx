"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// Roster CSV import — reads a file picker, posts the text to the
// import endpoint, surfaces a brief result + per-row error list.
// Sits inline in the roster page toolbar next to "Manage shifts" /
// "Manage positions" so admin discovers it where they already think
// about roster config.

type ImportResult = {
  ok: boolean;
  imported: number;
  skipped: number;
  errors: Array<{ line: number; reason: string }>;
};

const SAMPLE_CSV =
`# Drag-drop this CSV into the upload button on /admin/persona/roster
# Lines starting with # are ignored. Header row is required.
# date         YYYY-MM-DD
# position     Matches a position title configured for this branch (case-insensitive)
# username     Matches users.username assigned to this branch
# shift_code   Matches a shift code configured for this branch (case-insensitive)
date,position,username,shift_code
2026-06-01,Cashier,alice,M
2026-06-01,Kitchen,bob,F
2026-06-02,Cashier,alice,E
`;

export default function CsvImportButton() {
  const router = useRouter();
  const { t } = useLang();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const text = await file.text();
      const res = await fetch(apiUrl("/api/admin/persona/roster/csv-import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        const code = j?.error ?? "unknown";
        // Helpful per-code copy so admin knows how to fix.
        const map: Record<string, string> = {
          empty_csv: t("admin.persona.roster.csv.errEmpty"),
          missing_column: t("admin.persona.roster.csv.errMissingColumn",
            { column: j.column ?? "?", expected: j.expected ?? "" }),
          invalid_body: t("admin.persona.roster.csv.errInvalidBody"),
          forbidden: t("admin.persona.roster.csv.errForbidden")
        };
        setError(map[code] ?? `${code}`);
        return;
      }
      setResult(j as ImportResult);
      // Hard refresh so the grid reflects the new assignments.
      router.refresh();
    } catch {
      setError(t("admin.persona.roster.csv.errNetwork"));
    } finally {
      setBusy(false);
      // Reset the input so re-uploading the SAME file fires onChange.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function downloadSample() {
    const blob = new Blob([SAMPLE_CSV], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "roster-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="inline-flex items-center gap-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {busy
            ? t("admin.persona.roster.csv.importing")
            : t("admin.persona.roster.csv.import")}
        </button>
        <button
          type="button"
          onClick={downloadSample}
          className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50"
        >
          ⬇ {t("admin.persona.roster.csv.template")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="hidden"
          onChange={onFile}
        />
      </div>

      {/* Result + error panel — only visible after an attempt. */}
      {(result || error) && (
        <div className={`card mt-3 ${
          error ? "border-rose-300 bg-rose-50/40"
            : result && result.skipped > 0 ? "border-amber-300 bg-amber-50/40"
            : "border-emerald-300 bg-emerald-50/40"
        }`}>
          {error && (
            <div className="text-sm text-rose-700">
              ✗ {error}
              <button
                type="button"
                onClick={() => setError(null)}
                className="ml-3 text-xs underline text-rose-600"
              >
                {t("common.dismiss")}
              </button>
            </div>
          )}
          {result && (
            <div>
              <div className="text-sm text-slate-800 font-bold">
                ✓ {t("admin.persona.roster.csv.resultSummary", {
                  imported: result.imported,
                  skipped: result.skipped
                })}
              </div>
              {result.errors.length > 0 && (
                <details className="mt-2">
                  <summary className="text-xs text-rose-700 cursor-pointer">
                    {t("admin.persona.roster.csv.viewErrors", { n: result.errors.length })}
                  </summary>
                  <ul className="mt-1.5 text-[11px] text-rose-700 space-y-0.5 font-mono">
                    {result.errors.map((e, i) => (
                      <li key={i}>
                        {t("admin.persona.roster.csv.errorLine", {
                          line: e.line, reason: e.reason
                        })}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <button
                type="button"
                onClick={() => setResult(null)}
                className="mt-2 text-xs underline text-slate-500"
              >
                {t("common.dismiss")}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
