"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";

// "สร้างเอกสาร" — pick a company/branch scope and a format (CSV / XLSX / PDF),
// with an optional header note, then download from the export API (owner
// 2026-09-06). Scope options are computed server-side (listExportScopes).

export type ScopeOpt = {
  value: string;
  label: string;
  kind: "all" | "company" | "branch";
  companyKey?: number | null;
};

type Format = "csv" | "xlsx" | "pdf";

const FORMATS: Array<{ id: Format; label: string; hint: string }> = [
  { id: "csv", label: "CSV", hint: "เปิดใน Excel / นำเข้าโปรแกรมบัญชี" },
  { id: "xlsx", label: "Excel (XLSX)", hint: "แยกชีตต่อบริษัท/สาขา พร้อมสูตรบวกได้" },
  { id: "pdf", label: "PDF", hint: "เอกสารพร้อมพิมพ์/ส่งบัญชี" }
];

export default function ExportDialog({ month, scopes }: { month: string; scopes: ScopeOpt[] }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState("all");
  const [format, setFormat] = useState<Format>("pdf");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const download = () => {
    const params = new URLSearchParams({ m: month, scope, format });
    if (note.trim()) params.set("note", note.trim());
    // PDF renders inline (new tab); CSV/XLSX download as attachments.
    window.open(`/api/admin/persona/payroll/summary/export?${params.toString()}`, "_blank");
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg border border-brand text-brand font-medium hover:bg-amber-50"
      >
        <Icon name="download" className="h-4 w-4" />
        สร้างเอกสาร
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div
            className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full p-5 space-y-4 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="font-semibold text-slate-800 text-lg">สร้างเอกสารสรุปค่าตอบแทน</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                เลือกบริษัท/สาขา และรูปแบบไฟล์ · เอกสารจะมีรอบจ่าย (สำหรับกระทบยอด) และทำเครื่องหมายรายการหักให้อัตโนมัติ
              </p>
            </div>

            {/* Scope */}
            <div>
              <label className="label">1. ออกเอกสารของบริษัท/สาขาใด</label>
              <select
                className="input w-full"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                {scopes.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.kind === "branch" ? ` – ${o.label}`
                      : o.kind === "company" ? `${o.label} (ทั้งบริษัท)`
                      : o.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Format */}
            <div>
              <label className="label">2. รูปแบบไฟล์</label>
              <div className="grid grid-cols-1 gap-2">
                {FORMATS.map((f) => (
                  <label
                    key={f.id}
                    className={`flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer ${
                      format === f.id ? "border-brand bg-amber-50" : "border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="radio" name="format" className="mt-1"
                      checked={format === f.id}
                      onChange={() => setFormat(f.id)}
                    />
                    <span>
                      <span className="font-medium text-slate-800 text-sm">{f.label}</span>
                      <span className="block text-xs text-slate-500">{f.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Optional note */}
            <div>
              <label className="label">3. ข้อความหัวเอกสาร (ถ้ามี)</label>
              <input
                type="text"
                className="input w-full"
                value={note}
                maxLength={300}
                onChange={(e) => setNote(e.target.value)}
                placeholder="เช่น สำหรับยื่น ภ.ง.ด.1 เดือนนี้ / ส่งสำนักงานบัญชี"
              />
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="button" onClick={() => setOpen(false)}
                className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium"
              >
                ยกเลิก
              </button>
              <button
                type="button" onClick={download}
                className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-bold hover:opacity-90 inline-flex items-center justify-center gap-1.5"
              >
                <Icon name="download" className="h-4 w-4" />
                ดาวน์โหลด
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
