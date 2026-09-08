"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";

// "ดึงรายชื่อ/ข้อมูลพนักงาน" — pick company/branch, choose which columns, and a
// format (CSV / XLSX / PDF), then download (owner 2026-09-07). Same shape as the
// payroll "สร้างเอกสาร" export. Sensitive columns only appear when the admin has
// payroll access (the server enforces this too).

export type ScopeOpt = { value: string; label: string; kind: "all" | "company" | "branch"; companyKey?: number | null };
export type FieldOpt = { key: string; header: string; sensitive?: boolean };

type Format = "csv" | "xlsx" | "pdf";
const FORMATS: Array<{ id: Format; label: string; hint: string }> = [
  { id: "xlsx", label: "Excel (XLSX)", hint: "แยกชีตต่อบริษัท · เรียง/กรองต่อได้" },
  { id: "csv", label: "CSV", hint: "เปิดใน Excel / นำเข้าโปรแกรมอื่น" },
  { id: "pdf", label: "PDF", hint: "พร้อมพิมพ์/ส่งต่อ" }
];

// Selected by default — the common roster columns (name is always included).
const DEFAULT_FIELDS = new Set(["employee_code", "home_branch", "employment_type", "status", "hire_date"]);

export default function EmployeeExportDialog({ scopes, fields }: { scopes: ScopeOpt[]; fields: FieldOpt[] }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState("all");
  const [format, setFormat] = useState<Format>("xlsx");
  const [note, setNote] = useState("");
  const [sel, setSel] = useState<Set<string>>(() => new Set(DEFAULT_FIELDS));

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const toggle = (k: string) => setSel((prev) => {
    const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n;
  });

  const general = fields.filter((f) => !f.sensitive && f.key !== "name");
  const sensitive = fields.filter((f) => f.sensitive);

  const download = () => {
    const chosen = [...sel];
    const params = new URLSearchParams({ scope, format, fields: chosen.join(",") });
    if (note.trim()) params.set("note", note.trim());
    window.open(`/api/admin/persona/employees/export?${params.toString()}`, "_blank");
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
        ดึงรายชื่อ/ข้อมูลพนักงาน
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-2xl w-full p-5 space-y-4 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <div>
              <h3 className="font-semibold text-slate-800 text-lg">ดึงรายชื่อ / ข้อมูลพนักงาน</h3>
              <p className="text-xs text-slate-500 mt-0.5">เลือกบริษัท/สาขา · เลือกข้อมูลที่จะดึง · รูปแบบไฟล์ (แยกหัวข้อตามสาขา)</p>
            </div>

            {/* Scope */}
            <div>
              <label className="label">1. บริษัท / สาขา</label>
              <select className="input w-full" value={scope} onChange={(e) => setScope(e.target.value)}>
                {scopes.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.kind === "branch" ? ` – ${o.label}` : o.kind === "company" ? `${o.label} (ทั้งบริษัท)` : o.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Fields */}
            <div>
              <label className="label">2. เลือกข้อมูลที่จะดึง (ชื่อ-นามสกุล มีเสมอ)</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {general.map((f) => (
                  <label key={f.key} className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input type="checkbox" checked={sel.has(f.key)} onChange={() => toggle(f.key)} className="accent-brand" />
                    <span className="text-slate-700">{f.header}</span>
                  </label>
                ))}
              </div>
              {sensitive.length > 0 && (
                <>
                  <div className="text-xs font-medium text-rose-700 mt-3 mb-1">ข้อมูลอ่อนไหว (การเงิน/เลขบัตร) — ต้องมีสิทธิ์ดูค่าตอบแทน</div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                    {sensitive.map((f) => (
                      <label key={f.key} className="flex items-center gap-1.5 text-sm cursor-pointer">
                        <input type="checkbox" checked={sel.has(f.key)} onChange={() => toggle(f.key)} className="accent-rose-500" />
                        <span className="text-slate-700">{f.header}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Format */}
            <div>
              <label className="label">3. รูปแบบไฟล์</label>
              <div className="grid grid-cols-1 gap-2">
                {FORMATS.map((f) => (
                  <label key={f.id} className={`flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer ${format === f.id ? "border-brand bg-amber-50" : "border-slate-200 hover:bg-slate-50"}`}>
                    <input type="radio" name="empfmt" className="mt-1" checked={format === f.id} onChange={() => setFormat(f.id)} />
                    <span>
                      <span className="font-medium text-slate-800 text-sm">{f.label}</span>
                      <span className="block text-xs text-slate-500">{f.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="label">4. ข้อความหัวเอกสาร (ถ้ามี)</label>
              <input type="text" className="input w-full" value={note} maxLength={300}
                onChange={(e) => setNote(e.target.value)} placeholder="เช่น ทะเบียนพนักงาน ณ ก.ย. 2569" />
            </div>

            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setOpen(false)}
                className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium">
                ยกเลิก
              </button>
              <button type="button" onClick={download}
                className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-bold hover:opacity-90 inline-flex items-center justify-center gap-1.5">
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
