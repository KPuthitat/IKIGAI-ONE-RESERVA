"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Branch, User } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { useConfirm } from "@/app/components/useConfirm";

type UserWithBranches = User & { branch_ids: number[] };

export default function StaffClient({
  users, branches
}: { users: UserWithBranches[]; branches: Branch[] }) {
  const router = useRouter();
  const { t } = useLang();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    username: "", password: "", display_name: "",
    role: "staff" as "admin" | "staff",
    branch_ids: branches.map((b) => b.id)
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, alert, ConfirmDialog } = useConfirm();

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const res = await fetch(apiUrl("/api/admin/staff"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error || t("admin.users.createFailed"));
      return;
    }
    setForm({ ...form, username: "", password: "", display_name: "" });
    setCreating(false);
    router.refresh();
  }

  async function deleteUser(id: number, name: string) {
    const ok = await confirm({
      title: t("admin.users.confirmDeleteTitle"),
      body: <p>{t("admin.users.confirmDelete", { name })}</p>,
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      variant: "danger"
    });
    if (ok === null) return;
    const res = await fetch(apiUrl(`/api/admin/staff/${id}`), { method: "DELETE" });
    if (!res.ok) {
      alert({ title: t("common.error"), body: <p>{t("admin.users.deleteFailed")}</p>, variant: "danger", okLabel: t("common.confirm") });
      return;
    }
    router.refresh();
  }

  async function resetPassword(id: number) {
    const np = await confirm({
      title: t("admin.users.promptNewPasswordTitle"),
      body: <p className="text-xs text-slate-500">{t("admin.users.promptNewPasswordHint")}</p>,
      confirmLabel: t("common.save"),
      cancelLabel: t("common.cancel"),
      withInput: true,
      inputLabel: t("admin.users.promptNewPassword"),
      inputPlaceholder: t("admin.users.passwordPlaceholder")
    });
    if (np === null) return;
    if (np.length < 6) {
      alert({ title: t("common.error"), body: <p>{t("admin.users.passwordTooShort")}</p>, variant: "warning", okLabel: t("common.confirm") });
      return;
    }
    const res = await fetch(apiUrl(`/api/admin/staff/${id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: np })
    });
    if (!res.ok) {
      alert({ title: t("common.error"), body: <p>{t("admin.users.changePasswordFailed")}</p>, variant: "danger", okLabel: t("common.confirm") });
      return;
    }
    alert({ title: t("common.saved"), body: <p>{t("admin.users.changePasswordOk")}</p>, variant: "info", okLabel: t("common.confirm") });
  }

  async function updateBranches(id: number, branchIds: number[]) {
    const res = await fetch(apiUrl(`/api/admin/staff/${id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch_ids: branchIds })
    });
    if (!res.ok) {
      alert({ title: t("common.error"), body: <p>{t("admin.users.updateBranchesFailed")}</p>, variant: "danger", okLabel: t("common.confirm") });
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <button onClick={() => setCreating(!creating)} className="btn-primary">
        {creating ? t("admin.users.cancel") : t("admin.users.addUser")}
      </button>

      {creating && (
        <form onSubmit={createUser} className="card space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label">{t("admin.users.field.username")}</label>
              <input
                className="input" required minLength={3}
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </div>
            <div>
              <label className="label">{t("admin.users.field.displayName")}</label>
              <input
                className="input" required
                value={form.display_name}
                onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              />
            </div>
            <div>
              <label className="label">{t("admin.users.field.password")}</label>
              <input
                type="password" className="input" required minLength={6}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </div>
            <div>
              <label className="label">{t("admin.users.field.role")}</label>
              <select
                className="input" value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as "admin" | "staff" })}
              >
                <option value="staff">{t("admin.users.role.staffDesc")}</option>
                <option value="admin">{t("admin.users.role.adminDesc")}</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label">{t("admin.users.field.branches")}</label>
            <div className="flex flex-wrap gap-3">
              {branches.map((b) => (
                <label key={b.id} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={form.branch_ids.includes(b.id)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...form.branch_ids, b.id]
                        : form.branch_ids.filter((x) => x !== b.id);
                      setForm({ ...form, branch_ids: next });
                    }}
                  /> {b.name}
                </label>
              ))}
            </div>
          </div>
          {err && <div className="text-red-600 text-sm">{err}</div>}
          <button className="btn-primary" disabled={busy}>
            {busy ? t("common.saving") : t("admin.users.create")}
          </button>
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-2">{t("admin.users.col.displayName")}</th>
              <th>{t("admin.users.col.username")}</th>
              <th>{t("admin.users.col.role")}</th>
              <th>{t("admin.users.col.branches")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-slate-100 align-top">
                <td className="py-2 font-medium">{u.display_name}</td>
                <td>{u.username}</td>
                <td>
                  <span className={u.role === "admin" ? "text-brand font-medium" : "text-slate-600"}>
                    {u.role}
                  </span>
                </td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    {branches.map((b) => (
                      <label key={b.id} className="text-xs flex items-center gap-1">
                        <input
                          type="checkbox"
                          defaultChecked={u.branch_ids.includes(b.id)}
                          onChange={(e) => {
                            const set = new Set(u.branch_ids);
                            if (e.target.checked) set.add(b.id); else set.delete(b.id);
                            updateBranches(u.id, [...set]);
                          }}
                        /> {b.name}
                      </label>
                    ))}
                  </div>
                </td>
                <td className="text-right whitespace-nowrap">
                  <button onClick={() => resetPassword(u.id)} className="text-xs text-brand mr-2">
                    {t("admin.users.changePassword")}
                  </button>
                  <button onClick={() => deleteUser(u.id, u.display_name)} className="text-xs text-red-600">
                    {t("admin.users.delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ConfirmDialog}
    </div>
  );
}
