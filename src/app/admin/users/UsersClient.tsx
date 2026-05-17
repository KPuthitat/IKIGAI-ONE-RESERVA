"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

export type UserRow = {
  id: number;
  username: string;
  display_name: string;
  role: "super_admin" | "admin" | "staff";
};
export type BranchRow = {
  id: number;
  name: string;
  company_id: number | null;
  company_name: string;
};
export type GrantRow = { user_id: number; branch_id: number; is_admin: number };

type Level = "none" | "member" | "admin";

const LEVELS: { value: Level; label: string }[] = [
  { value: "none", label: "ไม่มีสิทธิ์" },
  { value: "member", label: "เข้าได้" },
  { value: "admin", label: "แอดมินสาขา" }
];

export default function UsersClient({
  users,
  branches,
  grants
}: {
  users: UserRow[];
  branches: BranchRow[];
  grants: GrantRow[];
}) {
  const router = useRouter();

  // Branches grouped by company, preserving the server's ordering.
  const groups = useMemo(() => {
    const out: { company: string; branches: BranchRow[] }[] = [];
    for (const b of branches) {
      let g = out.find((x) => x.company === b.company_name);
      if (!g) {
        g = { company: b.company_name, branches: [] };
        out.push(g);
      }
      g.branches.push(b);
    }
    return out;
  }, [branches]);

  // editState[userId] = { role, level: { [branchId]: Level } }
  const initial = useMemo(() => {
    const m: Record<
      number,
      { role: "admin" | "staff"; level: Record<number, Level> }
    > = {};
    for (const u of users) {
      if (u.role === "super_admin") continue;
      const level: Record<number, Level> = {};
      for (const b of branches) level[b.id] = "none";
      for (const g of grants) {
        if (g.user_id === u.id) level[g.branch_id] = g.is_admin ? "admin" : "member";
      }
      m[u.id] = { role: u.role, level };
    }
    return m;
  }, [users, branches, grants]);

  const [edit, setEdit] = useState(initial);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<Record<number, string>>({});

  function setLevel(userId: number, branchId: number, lvl: Level) {
    setEdit((p) => ({
      ...p,
      [userId]: { ...p[userId], level: { ...p[userId].level, [branchId]: lvl } }
    }));
  }
  function setRole(userId: number, role: "admin" | "staff") {
    setEdit((p) => ({ ...p, [userId]: { ...p[userId], role } }));
  }

  async function save(u: UserRow) {
    const e = edit[u.id];
    if (!e) return;
    setBusy(u.id);
    setMsg((m) => ({ ...m, [u.id]: "" }));
    const grantsPayload = branches
      .filter((b) => e.level[b.id] !== "none")
      .map((b) => ({ branch_id: b.id, is_admin: e.level[b.id] === "admin" }));
    const res = await fetch(apiUrl(`/api/admin/users/${u.id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: e.role, grants: grantsPayload })
    });
    setBusy(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setMsg((m) => ({ ...m, [u.id]: j.error || "บันทึกไม่สำเร็จ" }));
      return;
    }
    setMsg((m) => ({ ...m, [u.id]: "บันทึกแล้ว" }));
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {users.map((u) => {
        const e = edit[u.id];
        const isSuper = u.role === "super_admin";
        const adminCount = e
          ? Object.values(e.level).filter((l) => l === "admin").length
          : 0;
        return (
          <div key={u.id} className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-bold text-slate-800">{u.display_name}</div>
                <div className="text-xs text-slate-400">@{u.username}</div>
              </div>
              {isSuper ? (
                <span className="text-[11px] px-2 py-1 rounded-full bg-amber-100 text-amber-700 font-medium">
                  ผู้ดูแลระบบสูงสุด · เข้าทุกสาขาอัตโนมัติ
                </span>
              ) : (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-slate-500">บทบาท</span>
                  <select
                    className="input !w-auto !py-1 text-sm"
                    value={e?.role ?? "staff"}
                    onChange={(ev) =>
                      setRole(u.id, ev.target.value as "admin" | "staff")
                    }
                  >
                    <option value="staff">พนักงาน</option>
                    <option value="admin">แอดมิน</option>
                  </select>
                </div>
              )}
            </div>

            {isSuper ? (
              <p className="text-xs text-slate-400">
                บัญชีนี้เป็นผู้ดูแลระบบสูงสุด เข้าถึงและจัดการได้ทุกสาขา
                ไม่ต้องตั้งค่าที่นี่
              </p>
            ) : (
              <>
                {e?.role === "admin" && adminCount === 0 && (
                  <p className="text-xs text-amber-600">
                    บทบาทเป็น “แอดมิน” แต่ยังไม่ได้เปิดสิทธิ์แอดมินสาขาใดเลย —
                    จะยังเข้าหน้าผู้ดูแลไม่ได้จนกว่าจะมีอย่างน้อยหนึ่งสาขา
                  </p>
                )}
                {groups.map((g) => (
                  <div key={g.company} className="space-y-2">
                    <div className="text-[11px] tracking-[1px] text-slate-400 uppercase">
                      {g.company}
                    </div>
                    {g.branches.map((b) => (
                      <div
                        key={b.id}
                        className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2"
                      >
                        <span className="text-sm text-slate-700">{b.name}</span>
                        <div className="flex rounded-lg overflow-hidden border border-slate-200">
                          {LEVELS.map((lv) => {
                            const active = (e?.level[b.id] ?? "none") === lv.value;
                            return (
                              <button
                                key={lv.value}
                                type="button"
                                onClick={() => setLevel(u.id, b.id, lv.value)}
                                className={
                                  "px-3 py-1 text-xs transition " +
                                  (active
                                    ? "bg-brand text-white font-medium"
                                    : "bg-white text-slate-500 hover:bg-slate-50")
                                }
                              >
                                {lv.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}

                <div className="flex items-center gap-3 pt-1">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy === u.id}
                    onClick={() => save(u)}
                  >
                    {busy === u.id ? "กำลังบันทึก…" : "บันทึก"}
                  </button>
                  {msg[u.id] && (
                    <span
                      className={
                        "text-sm " +
                        (msg[u.id] === "บันทึกแล้ว"
                          ? "text-green-600"
                          : "text-red-600")
                      }
                    >
                      {msg[u.id]}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
