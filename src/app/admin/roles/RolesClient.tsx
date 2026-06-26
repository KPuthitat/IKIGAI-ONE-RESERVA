"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RbacPermissionDef } from "@/lib/rbac";

type Role = {
  id: number;
  key: string | null;
  name: string;
  description: string | null;
  is_system: number;
  permissions: string[];
  user_count: number;
};

export default function RolesClient({
  roles,
  catalog
}: {
  roles: Role[];
  catalog: RbacPermissionDef[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleDelete(role: Role) {
    if (role.is_system === 1) return;
    const warn =
      role.user_count > 0
        ? `บทบาท "${role.name}" มีพนักงานถืออยู่ ${role.user_count} คน — ลบแล้วคนเหล่านั้นจะเสียสิทธิ์ที่บทบาทนี้ให้ ต้องการลบหรือไม่?`
        : `ลบบทบาท "${role.name}" หรือไม่?`;
    if (!window.confirm(warn)) return;
    setBusyId(role.id);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/roles/${role.id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error === "system_role" ? "บทบาทระบบลบไม่ได้" : "ลบไม่สำเร็จ");
        return;
      }
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button className="btn-primary" onClick={() => { setErr(null); setEditing("new"); }}>
          + สร้างบทบาทใหม่
        </button>
      </div>

      {err && (
        <div className="card bg-red-50 border border-red-200 text-sm text-red-700">{err}</div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {roles.map((role) => (
          <div key={role.id} className="card space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-slate-800">{role.name}</h3>
                  {role.is_system === 1 && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-medium">
                      บทบาทระบบ
                    </span>
                  )}
                </div>
                {role.description && (
                  <p className="text-xs text-slate-500 mt-0.5">{role.description}</p>
                )}
              </div>
              <span className="text-xs text-slate-400 whitespace-nowrap">
                {role.user_count} คน
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {role.permissions.length === 0 ? (
                <span className="text-xs text-slate-400">— ยังไม่ได้ให้สิทธิ์โมดูลใด —</span>
              ) : (
                role.permissions.map((pk) => {
                  const def = catalog.find((c) => c.key === pk);
                  return (
                    <span
                      key={pk}
                      className="text-[11px] px-2 py-0.5 rounded-full bg-brand/10 text-brand font-medium"
                    >
                      {def ? def.module : pk}
                    </span>
                  );
                })
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button
                className="text-sm text-brand hover:underline"
                onClick={() => { setErr(null); setEditing(role); }}
              >
                แก้ไข
              </button>
              {role.is_system !== 1 && (
                <button
                  className="text-sm text-red-600 hover:underline disabled:opacity-50"
                  disabled={busyId === role.id}
                  onClick={() => handleDelete(role)}
                >
                  ลบ
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <RoleEditor
          role={editing === "new" ? null : editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); router.refresh(); }}
        />
      )}
    </div>
  );
}

function RoleEditor({
  role,
  catalog,
  onClose,
  onSaved
}: {
  role: Role | null;
  catalog: RbacPermissionDef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggle(key: string) {
    setPerms((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save() {
    if (name.trim() === "") {
      setErr("กรุณาตั้งชื่อบทบาท");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        permissions: [...perms]
      };
      const res = role
        ? await fetch(`/api/admin/roles/${role.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          })
        : await fetch("/api/admin/roles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
      if (!res.ok) {
        setErr("บันทึกไม่สำเร็จ");
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-slate-800">
          {role ? "แก้ไขบทบาท" : "สร้างบทบาทใหม่"}
        </h2>

        <div>
          <label className="label">ชื่อบทบาท</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="เช่น ฝ่ายบุคคล, ผู้จัดการสาขา"
            maxLength={60}
          />
        </div>

        <div>
          <label className="label">คำอธิบาย (ไม่บังคับ)</label>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="อธิบายสั้น ๆ ว่าบทบาทนี้ทำอะไร"
            maxLength={200}
          />
        </div>

        <div>
          <label className="label">เข้าถึงโมดูลใดได้บ้าง</label>
          <div className="space-y-2 mt-1">
            {catalog.map((p) => (
              <label
                key={p.key}
                className="flex items-start gap-2 p-2 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={perms.has(p.key)}
                  onChange={() => toggle(p.key)}
                />
                <span>
                  <span className="text-sm font-medium text-slate-800">{p.labelTh}</span>
                  <span className="block text-xs text-slate-500">{p.descTh}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {err && <div className="text-sm text-red-600">{err}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800" onClick={onClose}>
            ยกเลิก
          </button>
          <button className="btn-primary" disabled={busy} onClick={save}>
            {busy ? "กำลังบันทึก…" : "บันทึก"}
          </button>
        </div>
      </div>
    </div>
  );
}
