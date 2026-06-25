"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";

type User = { id: number; display_name: string; title_prefix: string | null; role: string };
type Branch = { id: number; name: string };
type Grant = { user_id: number; branch_id: number; can_confirm: number };
type Level = "none" | "view" | "confirm";

const key = (u: number, b: number) => `${u}:${b}`;

export default function AccessMatrixClient({
  users, branches, grants
}: { users: User[]; branches: Branch[]; grants: Grant[] }) {
  const [map, setMap] = useState<Record<string, Level>>(() => {
    const m: Record<string, Level> = {};
    for (const g of grants) m[key(g.user_id, g.branch_id)] = g.can_confirm ? "confirm" : "view";
    return m;
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function setLevel(userId: number, branchId: number, level: Level) {
    const k = key(userId, branchId);
    const prev = map[k] ?? "none";
    setMap((m) => ({ ...m, [k]: level }));
    setBusy(k); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/accounta/access"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, branch_id: branchId, level })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setMap((m) => ({ ...m, [k]: prev })); setErr("บันทึกไม่สำเร็จ"); }
    } catch {
      setMap((m) => ({ ...m, [k]: prev })); setErr("บันทึกไม่สำเร็จ");
    } finally { setBusy(null); }
  }

  return (
    <div className="space-y-2">
      {err && <p className="text-sm text-rose-600">{err}</p>}
      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-[11px] text-slate-400">
              <th className="text-left px-3 py-2 sticky left-0 bg-white">ผู้ใช้</th>
              {branches.map((b) => <th key={b.id} className="px-3 py-2 text-center min-w-[8rem]">{b.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSuper = u.role === "super_admin";
              return (
                <tr key={u.id} className="border-b border-slate-50">
                  <td className="px-3 py-2 sticky left-0 bg-white">
                    <div className="font-medium text-slate-800">{u.title_prefix ? `${u.title_prefix} ` : ""}{u.display_name}</div>
                    {isSuper && <div className="text-[10px] text-indigo-500">super admin · ทุกสาขา</div>}
                  </td>
                  {branches.map((b) => {
                    const k = key(u.id, b.id);
                    const level: Level = isSuper ? "confirm" : (map[k] ?? "none");
                    return (
                      <td key={b.id} className="px-3 py-2 text-center">
                        {isSuper ? (
                          <span className="text-[11px] text-slate-400">ยืนยัน (auto)</span>
                        ) : (
                          <select value={level} disabled={busy === k}
                            onChange={(e) => setLevel(u.id, b.id, e.target.value as Level)}
                            className={`input !py-1 !text-xs !w-auto mx-auto ${level === "confirm" ? "!border-emerald-300 bg-emerald-50"
                              : level === "view" ? "!border-sky-300 bg-sky-50" : ""}`}>
                            <option value="none">— ไม่มีสิทธิ์</option>
                            <option value="view">ดูอย่างเดียว</option>
                            <option value="confirm">ยืนยันลงบัญชี</option>
                          </select>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {users.length === 0 && (
              <tr><td colSpan={branches.length + 1} className="px-3 py-6 text-center text-slate-400">ยังไม่มีแอดมินให้กำหนดสิทธิ์</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-400">เปลี่ยนแล้วบันทึกอัตโนมัติทันที</p>
    </div>
  );
}
