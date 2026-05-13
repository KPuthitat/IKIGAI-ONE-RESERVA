"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import type { Company } from "@/lib/db";

export default function CompaniesClient({
  companies
}: {
  companies: Array<Company & { branch_count: number }>;
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

  return (
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
  );
}

function CompanyRow({
  company, editing, onStartEdit, onCancel, onSave, busy, t
}: {
  company: (Company & { branch_count: number }) | null;
  editing?: boolean;
  onStartEdit?: () => void;
  onCancel: () => void;
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
        <button type="button" onClick={onStartEdit}
          className="text-xs text-brand hover:underline">
          {t("common.edit")}
        </button>
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
