"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import type { Company } from "@/lib/db";

type BranchLite = { id: number; name: string; company_id: number | null };

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
    if (c.branch_count > 0) {
      setErr(`ลบไม่ได้ — บริษัทนี้ยังมี ${c.branch_count} สาขา ย้ายสาขาออกก่อน`);
      return;
    }
    if (!window.confirm(`ลบบริษัท “${c.name_th}” ?`)) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/companies"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(
          j.error === "company_has_branches"
            ? `ลบไม่ได้ — ยังมี ${j.branch_count} สาขาผูกอยู่`
            : j.error ?? t("common.error")
        );
        return;
      }
      refresh();
    } catch {
      setErr(t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function assignBranch(branchId: number, companyId: number | null) {
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/companies/assign-branch"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch_id: branchId, company_id: companyId })
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

      {/* Branch → company assignment. Lets the owner move a branch
          between companies (and fix the earlier auto-seed mismatch). */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            สาขาทั้งหมด ({branches.length})
          </h2>
          <p className="text-[11px] text-slate-500">
            เลือกบริษัทที่แต่ละสาขาสังกัด — “— ไม่ระบุ —” คือยังไม่ผูกบริษัท
          </p>
        </div>
        <div className="space-y-2">
          {branches.map((b) => (
            <div key={b.id}
              className="border border-slate-200 rounded-lg p-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-slate-700">{b.name}</span>
              <select
                className="input text-sm !w-auto !py-1"
                value={b.company_id ?? ""}
                disabled={busy || pending}
                onChange={(e) =>
                  assignBranch(
                    b.id,
                    e.target.value === "" ? null : Number(e.target.value)
                  )
                }
              >
                <option value="">— ไม่ระบุ —</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name_th}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
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
            <span className="text-brand">
              {t("admin.companies.branchCount", { n: company.branch_count })}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <button type="button" onClick={onStartEdit}
            className="text-xs text-brand hover:underline">
            {t("common.edit")}
          </button>
          {onDelete && (
            <button type="button" onClick={onDelete}
              disabled={busy || company.branch_count > 0}
              title={company.branch_count > 0 ? "ย้ายสาขาออกก่อนจึงจะลบได้" : ""}
              className="text-xs text-rose-600 hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed">
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
          <label className="label text-[11px]">{t("admin.companies.field.address")}</label>
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
