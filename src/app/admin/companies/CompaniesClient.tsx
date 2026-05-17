"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import type { Company } from "@/lib/db";

type BranchLite = {
  id: number;
  name: string;
  company_id: number | null;
  reg_address: string | null;
  tax_branch_code: string | null;
};

export default function CompaniesClient({
  companies,
  branches
}: {
  companies: Array<Company & { branch_count: number }>;
  branches: BranchLite[];
}) {
  const router = useRouter();
  const { t } = useLang();
  const [pending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editingBranchId, setEditingBranchId] = useState<number | null>(null);

  function refresh() { startTransition(() => router.refresh()); }

  async function save(body: Record<string, unknown>, method: "POST" | "PATCH") {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/companies"), {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? t("common.error")); return false; }
      return true;
    } catch { setErr(t("common.error")); return false; }
    finally { setBusy(false); }
  }

  async function remove(c: Company & { branch_count: number }) {
    setErr(null);
    const warn =
      c.branch_count > 0
        ? `ลบบริษัท “${c.name_th}” ?\n\nสาขา ${c.branch_count} แห่งที่ผูกอยู่จะถูกปลดออก (ไม่ระบุบริษัท) — ไปกำหนดบริษัทใหม่ให้ได้ภายหลัง`
        : `ลบบริษัท “${c.name_th}” ?`;
    if (!window.confirm(warn)) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/companies"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? t("common.error")); return; }
      refresh();
    } catch {
      setErr(t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function saveBranch(body: Record<string, unknown>) {
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/companies/assign-branch"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? t("common.error")); return false; }
      return true;
    } catch {
      setErr(t("common.error"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-slate-800 text-sm">
            {t("admin.companies.listTitle")} ({companies.length})
          </h2>
          {!creating && (
            <button type="button" onClick={() => setCreating(true)}
              className="text-xs px-3 py-1.5 rounded border border-brand text-brand hover:bg-rose-50 font-bold">
              + {t("admin.companies.add")}
            </button>
          )}
        </div>
        <p className="text-[11px] text-slate-500">
          1 บริษัทมีได้หลายสาขา · ถ้าบริษัทไม่มีสาขา ระบบถือว่าที่อยู่ของบริษัทคือ “สำนักงานใหญ่” โดยอัตโนมัติ
        </p>
        {err && <div className="text-xs text-rose-600">✗ {err}</div>}
        <div className="space-y-2">
          {creating && (
            <CompanyRow
              company={null}
              onCancel={() => setCreating(false)}
              onSave={async (body) => {
                if (await save(body, "POST")) { setCreating(false); refresh(); }
              }}
              busy={busy} t={t}
            />
          )}
          {companies.map((c) => (
            <CompanyRow
              key={c.id}
              company={c}
              editing={editingId === c.id}
              onStartEdit={() => setEditingId(c.id)}
              onCancel={() => setEditingId(null)}
              onDelete={() => remove(c)}
              onSave={async (body) => {
                if (await save({ id: c.id, ...body }, "PATCH")) {
                  setEditingId(null); refresh();
                }
              }}
              busy={busy} t={t}
            />
          ))}
        </div>
      </div>

      {/* Branch → company assignment + per-branch registered address.
          Each branch files its own ที่อยู่จดทะเบียน for paperwork. */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            สาขาทั้งหมด ({branches.length})
          </h2>
          <p className="text-[11px] text-slate-500">
            กำหนดบริษัทที่สังกัด และ “ที่อยู่จดทะเบียน” ของแต่ละสาขา (ใช้ทำเอกสารราชการ)
            — รหัสสาขาภาษี: 00000 = สำนักงานใหญ่, 00001 ขึ้นไป = สาขาที่ N
          </p>
        </div>
        <div className="space-y-2">
          {branches.map((b) => {
            const isEditing = editingBranchId === b.id;
            const company = companies.find((c) => c.id === b.company_id) ?? null;
            if (!isEditing) {
              return (
                <div key={b.id}
                  className="border border-slate-200 rounded-lg p-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-slate-700">{b.name}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span className={company ? "text-brand" : "text-amber-600"}>
                        {company ? company.name_th : "— ไม่ระบุบริษัท —"}
                      </span>
                      <span>สาขาภาษี: {b.tax_branch_code || "—"}</span>
                      {b.reg_address && (
                        <span className="text-slate-400 truncate max-w-[260px]">
                          {b.reg_address}
                        </span>
                      )}
                    </div>
                  </div>
                  <button type="button"
                    onClick={() => setEditingBranchId(b.id)}
                    className="text-xs text-brand hover:underline flex-shrink-0">
                    {t("common.edit")}
                  </button>
                </div>
              );
            }
            return (
              <BranchEditor
                key={b.id}
                branch={b}
                companies={companies}
                busy={busy}
                onCancel={() => setEditingBranchId(null)}
                onSave={async (body) => {
                  if (await saveBranch({ branch_id: b.id, ...body })) {
                    setEditingBranchId(null);
                    refresh();
                  }
                }}
                disabled={busy || pending}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BranchEditor({
  branch, companies, busy, onCancel, onSave
}: {
  branch: BranchLite;
  companies: Array<Company & { branch_count: number }>;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const [name, setName] = useState(branch.name);
  const [companyId, setCompanyId] = useState<string>(
    branch.company_id ? String(branch.company_id) : ""
  );
  const [taxCode, setTaxCode] = useState(branch.tax_branch_code ?? "");
  const [regAddress, setRegAddress] = useState(branch.reg_address ?? "");

  return (
    <div className="border-[1.5px] border-brand/50 bg-rose-50/30 rounded-lg p-3 space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div>
          <label className="label text-[11px]">ชื่อสาขา *</label>
          <input className="input text-sm" value={name}
            onChange={(e) => setName(e.target.value)} maxLength={120} />
        </div>
        <div>
          <label className="label text-[11px]">บริษัทที่สังกัด</label>
          <select className="input text-sm" value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">— ไม่ระบุบริษัท —</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name_th}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label text-[11px]">รหัสสาขาภาษี</label>
          <input className="input text-sm" value={taxCode}
            placeholder="00000 = สำนักงานใหญ่"
            onChange={(e) => setTaxCode(e.target.value)} maxLength={10} />
        </div>
        <div className="md:col-span-2">
          <label className="label text-[11px]">ที่อยู่จดทะเบียน (สำหรับเอกสารราชการ)</label>
          <textarea className="input text-sm" rows={2} value={regAddress}
            onChange={(e) => setRegAddress(e.target.value)} maxLength={1000} />
        </div>
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={busy || !name.trim()}
          onClick={() => onSave({
            name: name.trim(),
            company_id: companyId === "" ? null : Number(companyId),
            tax_branch_code: taxCode.trim() || null,
            reg_address: regAddress.trim() || null
          })}
          className="flex-1 py-1.5 rounded bg-brand text-white text-xs font-bold disabled:opacity-50">
          {busy ? "…" : "บันทึก"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}
          className="flex-1 py-1.5 rounded border border-slate-300 text-slate-600 text-xs">
          ยกเลิก
        </button>
      </div>
    </div>
  );
}

function CompanyRow({
  company, editing, onStartEdit, onCancel, onDelete, onSave, busy, t
}: {
  company: (Company & { branch_count: number }) | null;
  editing?: boolean;
  onStartEdit?: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  onSave: (body: Record<string, unknown>) => void;
  busy: boolean;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  const isNew = company === null;
  const isEditing = isNew || editing;

  const [nameTh, setNameTh] = useState(company?.name_th ?? "");
  const [nameEn, setNameEn] = useState(company?.name_en ?? "");
  const [taxId, setTaxId] = useState(company?.tax_id ?? "");
  const [address, setAddress] = useState(company?.address ?? "");
  const [phone, setPhone] = useState(company?.phone ?? "");
  const [email, setEmail] = useState(company?.email ?? "");

  if (!isEditing && company) {
    return (
      <div className="border border-slate-200 rounded-lg p-3 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-bold text-slate-800">{company.name_th}</div>
          {company.name_en && (
            <div className="text-xs text-slate-500">{company.name_en}</div>
          )}
          <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            {company.tax_id && <span>{t("admin.companies.taxIdShort")}: {company.tax_id}</span>}
            {company.phone && <span>📞 {company.phone}</span>}
            <span className={company.branch_count > 0 ? "text-brand" : "text-slate-400"}>
              {company.branch_count > 0
                ? t("admin.companies.branchCount", { n: company.branch_count })
                : "ไม่มีสาขา (ใช้ที่อยู่บริษัทเป็นสำนักงานใหญ่)"}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <button type="button" onClick={onStartEdit}
            className="text-xs text-brand hover:underline">
            {t("common.edit")}
          </button>
          {onDelete && (
            <button type="button" onClick={onDelete} disabled={busy}
              className="text-xs text-rose-600 hover:underline disabled:opacity-40">
              ลบ
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="border-[1.5px] border-brand/50 bg-rose-50/30 rounded-lg p-3 space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div>
          <label className="label text-[11px]">{t("admin.companies.field.nameTh")} *</label>
          <input className="input text-sm" value={nameTh}
            onChange={(e) => setNameTh(e.target.value)} maxLength={200} />
        </div>
        <div>
          <label className="label text-[11px]">{t("admin.companies.field.nameEn")}</label>
          <input className="input text-sm" value={nameEn}
            onChange={(e) => setNameEn(e.target.value)} maxLength={200} />
        </div>
        <div>
          <label className="label text-[11px]">{t("admin.companies.field.taxId")}</label>
          <input className="input text-sm" value={taxId}
            onChange={(e) => setTaxId(e.target.value)} maxLength={20} />
        </div>
        <div>
          <label className="label text-[11px]">{t("admin.companies.field.phone")}</label>
          <input className="input text-sm" value={phone}
            onChange={(e) => setPhone(e.target.value)} maxLength={40} />
        </div>
        <div className="md:col-span-2">
          <label className="label text-[11px]">{t("admin.companies.field.address")} (สำนักงานใหญ่)</label>
          <textarea className="input text-sm" rows={2} value={address}
            onChange={(e) => setAddress(e.target.value)} maxLength={1000} />
        </div>
        <div className="md:col-span-2">
          <label className="label text-[11px]">{t("admin.companies.field.email")}</label>
          <input className="input text-sm" value={email}
            onChange={(e) => setEmail(e.target.value)} maxLength={120} />
        </div>
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={busy || !nameTh.trim()}
          onClick={() => onSave({
            name_th: nameTh, name_en: nameEn || null,
            tax_id: taxId || null, address: address || null,
            phone: phone || null, email: email || null
          })}
          className="flex-1 py-1.5 rounded bg-brand text-white text-xs font-bold disabled:opacity-50">
          {busy ? "…" : t("common.save")}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}
          className="flex-1 py-1.5 rounded border border-slate-300 text-slate-600 text-xs">
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
