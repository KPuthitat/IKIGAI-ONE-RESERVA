"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { nameWithPrefix } from "@/lib/name";
import type { Company } from "@/lib/db";

type CompanyRowT = Company & { branch_count: number };
type BranchLite = {
  id: number;
  name: string;
  company_id: number | null;
  reg_address: string | null;
  tax_branch_code: string | null;
};
type UserLite = {
  id: number;
  display_name: string;
  username: string;
  role: "super_admin" | "admin" | "staff";
  title_prefix: string | null;
};
type GrantRow = { user_id: number; branch_id: number; is_admin: number };

export default function CompaniesClient({
  companies,
  branches,
  users,
  grants
}: {
  companies: CompanyRowT[];
  branches: BranchLite[];
  users: UserLite[];
  grants: GrantRow[];
}) {
  const router = useRouter();
  const { t } = useLang();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [creatingCompany, setCreatingCompany] = useState(false);
  const [editingCompanyId, setEditingCompanyId] = useState<number | null>(null);
  const [editingBranchId, setEditingBranchId] = useState<number | null>(null);
  const [addingBranchFor, setAddingBranchFor] = useState<number | null>(null);

  function refresh() { startTransition(() => router.refresh()); }

  const branchesByCompany = useMemo(() => {
    const m = new Map<number, BranchLite[]>();
    for (const b of branches) {
      if (b.company_id == null) continue;
      const arr = m.get(b.company_id) ?? [];
      arr.push(b);
      m.set(b.company_id, arr);
    }
    return m;
  }, [branches]);

  const unassigned = useMemo(
    () => branches.filter((b) => b.company_id == null),
    [branches]
  );

  const adminsByBranch = useMemo(() => {
    const m = new Map<number, UserLite[]>();
    const byId = new Map(users.map((u) => [u.id, u]));
    for (const g of grants) {
      if (!g.is_admin) continue;
      const u = byId.get(g.user_id);
      if (!u) continue;
      const arr = m.get(g.branch_id) ?? [];
      arr.push(u);
      m.set(g.branch_id, arr);
    }
    return m;
  }, [grants, users]);

  async function call(url: string, method: string, body: unknown) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(url), {
        method,
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

  async function deleteCompany(c: CompanyRowT) {
    const warn =
      c.branch_count > 0
        ? `ลบบริษัท “${c.name_th}” ?\n\nสาขา ${c.branch_count} แห่งที่ผูกอยู่จะถูกปลดออก (ไม่ระบุบริษัท)`
        : `ลบบริษัท “${c.name_th}” ?`;
    if (!window.confirm(warn)) return;
    if (await call("/api/admin/companies", "DELETE", { id: c.id })) refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-slate-500 flex-1">
          โครงสร้าง: บริษัท → สาขา → ผู้ดูแลระบบของสาขา · บริษัทที่ไม่มีสาขา
          ระบบถือว่าที่อยู่บริษัทคือ “สำนักงานใหญ่” อัตโนมัติ
        </p>
        {!creatingCompany && (
          <button type="button" onClick={() => setCreatingCompany(true)}
            className="text-xs px-3 py-1.5 rounded border border-brand text-brand hover:bg-rose-50 font-bold flex-shrink-0">
            + {t("admin.companies.add")}
          </button>
        )}
      </div>
      {err && <div className="text-xs text-rose-600">✗ {err}</div>}

      {creatingCompany && (
        <div className="card">
          <CompanyForm
            company={null}
            busy={busy}
            t={t}
            onCancel={() => setCreatingCompany(false)}
            onSave={async (body) => {
              if (await call("/api/admin/companies", "POST", body)) {
                setCreatingCompany(false); refresh();
              }
            }}
          />
        </div>
      )}

      {companies.map((c) => {
        const list = branchesByCompany.get(c.id) ?? [];
        const editing = editingCompanyId === c.id;
        return (
          <div key={c.id} className="card space-y-3">
            {editing ? (
              <CompanyForm
                company={c}
                busy={busy}
                t={t}
                onCancel={() => setEditingCompanyId(null)}
                onSave={async (body) => {
                  if (await call("/api/admin/companies", "PATCH", { id: c.id, ...body })) {
                    setEditingCompanyId(null); refresh();
                  }
                }}
              />
            ) : (
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-slate-800">{c.name_th}</div>
                  {c.name_en && <div className="text-xs text-slate-500">{c.name_en}</div>}
                  <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                    {c.tax_id && <span>{t("admin.companies.taxIdShort")}: {c.tax_id}</span>}
                    {c.phone && <span>โทร {c.phone}</span>}
                    <span className={list.length > 0 ? "text-brand" : "text-slate-400"}>
                      {list.length > 0
                        ? t("admin.companies.branchCount", { n: list.length })
                        : "ไม่มีสาขา (ใช้ที่อยู่บริษัทเป็นสำนักงานใหญ่)"}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <button type="button" onClick={() => setEditingCompanyId(c.id)}
                    className="text-xs text-brand hover:underline">
                    {t("common.edit")}
                  </button>
                  <button type="button" onClick={() => deleteCompany(c)} disabled={busy}
                    className="text-xs text-rose-600 hover:underline disabled:opacity-40">
                    ลบ
                  </button>
                </div>
              </div>
            )}

            {/* Branches under this company */}
            <div className="border-t border-slate-100 pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] tracking-[1px] text-slate-400 uppercase">
                  สาขา ({list.length})
                </span>
                {addingBranchFor !== c.id && (
                  <button type="button" onClick={() => setAddingBranchFor(c.id)}
                    className="text-xs text-brand hover:underline">
                    + เพิ่มสาขา
                  </button>
                )}
              </div>

              {addingBranchFor === c.id && (
                <BranchForm
                  busy={busy}
                  onCancel={() => setAddingBranchFor(null)}
                  onSave={async (body) => {
                    if (await call("/api/admin/companies/create-branch", "POST", {
                      company_id: c.id, ...body
                    })) {
                      setAddingBranchFor(null); refresh();
                    }
                  }}
                />
              )}

              {list.length === 0 && addingBranchFor !== c.id && (
                <p className="text-xs text-slate-400">ยังไม่มีสาขา</p>
              )}

              {list.map((b) => (
                <BranchBlock
                  key={b.id}
                  branch={b}
                  companies={companies}
                  admins={adminsByBranch.get(b.id) ?? []}
                  users={users}
                  editing={editingBranchId === b.id}
                  busy={busy || pending}
                  t={t}
                  onStartEdit={() => setEditingBranchId(b.id)}
                  onCancelEdit={() => setEditingBranchId(null)}
                  onSaveBranch={async (body) => {
                    if (await call("/api/admin/companies/assign-branch", "POST", {
                      branch_id: b.id, ...body
                    })) { setEditingBranchId(null); refresh(); }
                  }}
                  onSetAdmin={async (userId, isAdmin) => {
                    if (await call("/api/admin/companies/branch-admin", "POST", {
                      branch_id: b.id, user_id: userId, is_admin: isAdmin
                    })) refresh();
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* Branches not yet under any company */}
      {unassigned.length > 0 && (
        <div className="card space-y-3">
          <div>
            <h2 className="font-bold text-amber-700 text-sm">
              สาขาที่ยังไม่ระบุบริษัท ({unassigned.length})
            </h2>
            <p className="text-[11px] text-slate-500">
              กด “แก้ไขข้อมูลสาขา” แล้วเลือกบริษัทเพื่อย้ายเข้าโครงสร้าง
            </p>
          </div>
          {unassigned.map((b) => (
            <BranchBlock
              key={b.id}
              branch={b}
              companies={companies}
              admins={adminsByBranch.get(b.id) ?? []}
              users={users}
              editing={editingBranchId === b.id}
              busy={busy || pending}
              t={t}
              onStartEdit={() => setEditingBranchId(b.id)}
              onCancelEdit={() => setEditingBranchId(null)}
              onSaveBranch={async (body) => {
                if (await call("/api/admin/companies/assign-branch", "POST", {
                  branch_id: b.id, ...body
                })) { setEditingBranchId(null); refresh(); }
              }}
              onSetAdmin={async (userId, isAdmin) => {
                if (await call("/api/admin/companies/branch-admin", "POST", {
                  branch_id: b.id, user_id: userId, is_admin: isAdmin
                })) refresh();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BranchBlock({
  branch, companies, admins, users, editing, busy, t,
  onStartEdit, onCancelEdit, onSaveBranch, onSetAdmin
}: {
  branch: BranchLite;
  companies: CompanyRowT[];
  admins: UserLite[];
  users: UserLite[];
  editing: boolean;
  busy: boolean;
  t: (k: string, vars?: Record<string, string | number>) => string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveBranch: (body: Record<string, unknown>) => void;
  onSetAdmin: (userId: number, isAdmin: boolean) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [pickUserId, setPickUserId] = useState<string>("");

  const adminIds = new Set(admins.map((a) => a.id));
  const candidates = users.filter(
    (u) => u.role !== "super_admin" && !adminIds.has(u.id)
  );

  return (
    <div className="border border-slate-200 rounded-lg p-3 space-y-2">
      {editing ? (
        <BranchForm
          branch={branch}
          companies={companies}
          busy={busy}
          onCancel={onCancelEdit}
          onSave={onSaveBranch}
        />
      ) : (
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="font-medium text-slate-700">{branch.name}</div>
            <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
              <span>สาขาภาษี: {branch.tax_branch_code || "—"}</span>
              {branch.reg_address
                ? <span className="text-slate-400 truncate max-w-[280px]">{branch.reg_address}</span>
                : <span className="text-amber-600">ยังไม่ได้ลงที่อยู่จดทะเบียน</span>}
            </div>
          </div>
          <button type="button" onClick={onStartEdit}
            className="text-xs text-brand hover:underline flex-shrink-0">
            แก้ไขข้อมูลสาขา
          </button>
        </div>
      )}

      {/* Admins of this branch */}
      <div className="bg-slate-50 rounded-md p-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-slate-600">
            ผู้ดูแลระบบของสาขานี้
          </span>
          {!picking && candidates.length > 0 && (
            <button type="button" onClick={() => setPicking(true)}
              className="text-xs text-brand hover:underline">
              + เพิ่มผู้ดูแลระบบของสาขานี้
            </button>
          )}
        </div>

        {admins.length === 0 && (
          <p className="text-[11px] text-slate-400">ยังไม่มีผู้ดูแลระบบของสาขานี้</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {admins.map((a) => (
            <span key={a.id}
              className="inline-flex items-center gap-1 text-[11px] bg-white border border-slate-200 rounded-full pl-2 pr-1 py-0.5">
              {nameWithPrefix(a.title_prefix, a.display_name)}
              <button type="button" disabled={busy}
                onClick={() => onSetAdmin(a.id, false)}
                title="ถอดสิทธิ์ผู้ดูแลระบบสาขานี้"
                className="w-4 h-4 rounded-full bg-slate-100 hover:bg-rose-100 text-slate-500 hover:text-rose-600 disabled:opacity-40 leading-none">
                ×
              </button>
            </span>
          ))}
        </div>

        {picking && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <select className="input text-sm !w-auto !py-1"
              value={pickUserId}
              onChange={(e) => setPickUserId(e.target.value)}>
              <option value="">— เลือกผู้ใช้ —</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {nameWithPrefix(u.title_prefix, u.display_name)} (@{u.username}{u.role === "admin" ? " · ผู้ดูแลระบบ" : ""})
                </option>
              ))}
            </select>
            <button type="button" disabled={busy || !pickUserId}
              onClick={() => {
                onSetAdmin(Number(pickUserId), true);
                setPickUserId(""); setPicking(false);
              }}
              className="text-xs px-3 py-1 rounded bg-brand text-white font-bold disabled:opacity-50">
              เพิ่ม
            </button>
            <button type="button" disabled={busy}
              onClick={() => { setPicking(false); setPickUserId(""); }}
              className="text-xs px-3 py-1 rounded border border-slate-300 text-slate-600">
              ยกเลิก
            </button>
          </div>
        )}
        {candidates.length === 0 && !picking && admins.length > 0 && (
          <p className="text-[11px] text-slate-400">ผู้ใช้ทุกคนถูกเพิ่มเป็นผู้ดูแลระบบสาขานี้แล้ว</p>
        )}
      </div>
    </div>
  );
}

function BranchForm({
  branch, companies, busy, onCancel, onSave
}: {
  branch?: BranchLite;
  companies?: CompanyRowT[];
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(branch?.name ?? "");
  const [companyId, setCompanyId] = useState<string>(
    branch?.company_id ? String(branch.company_id) : ""
  );
  const [taxCode, setTaxCode] = useState(branch?.tax_branch_code ?? "");
  const [regAddress, setRegAddress] = useState(branch?.reg_address ?? "");
  const showCompany = !!branch && !!companies;

  return (
    <div className="border-[1.5px] border-brand/50 bg-rose-50/30 rounded-lg p-3 space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div>
          <label className="label text-[11px]">ชื่อสาขา *</label>
          <input className="input text-sm" value={name}
            onChange={(e) => setName(e.target.value)} maxLength={120} />
        </div>
        {showCompany && (
          <div>
            <label className="label text-[11px]">บริษัทที่สังกัด</label>
            <select className="input text-sm" value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">— ไม่ระบุบริษัท —</option>
              {companies!.map((c) => (
                <option key={c.id} value={c.id}>{c.name_th}</option>
              ))}
            </select>
          </div>
        )}
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
          onClick={() => {
            const body: Record<string, unknown> = {
              name: name.trim(),
              tax_branch_code: taxCode.trim() || null,
              reg_address: regAddress.trim() || null
            };
            if (showCompany) body.company_id = companyId === "" ? null : Number(companyId);
            onSave(body);
          }}
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

function CompanyForm({
  company, busy, t, onCancel, onSave
}: {
  company: CompanyRowT | null;
  busy: boolean;
  t: (k: string, vars?: Record<string, string | number>) => string;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [nameTh, setNameTh] = useState(company?.name_th ?? "");
  const [nameEn, setNameEn] = useState(company?.name_en ?? "");
  const [taxId, setTaxId] = useState(company?.tax_id ?? "");
  const [address, setAddress] = useState(company?.address ?? "");
  const [phone, setPhone] = useState(company?.phone ?? "");
  const [email, setEmail] = useState(company?.email ?? "");

  return (
    <div className="space-y-2">
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
