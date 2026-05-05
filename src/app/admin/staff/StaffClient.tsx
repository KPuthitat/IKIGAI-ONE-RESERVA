"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Branch, User } from "@/lib/db";
import { apiUrl } from "@/lib/url";

type UserWithBranches = User & { branch_ids: number[] };

export default function StaffClient({
  users, branches
}: { users: UserWithBranches[]; branches: Branch[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    username: "", password: "", display_name: "",
    role: "staff" as "admin" | "staff",
    branch_ids: branches.map((b) => b.id)
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      setErr(j.error || "สร้างไม่สำเร็จ");
      return;
    }
    setForm({ ...form, username: "", password: "", display_name: "" });
    setCreating(false);
    router.refresh();
  }

  async function deleteUser(id: number, name: string) {
    if (!confirm(`ลบบัญชี ${name}?`)) return;
    const res = await fetch(apiUrl(`/api/admin/staff/${id}`), { method: "DELETE" });
    if (!res.ok) { alert("ลบไม่สำเร็จ"); return; }
    router.refresh();
  }

  async function resetPassword(id: number) {
    const np = prompt("ใส่รหัสผ่านใหม่ (อย่างน้อย 6 ตัว):");
    if (!np || np.length < 6) return;
    const res = await fetch(apiUrl(`/api/admin/staff/${id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: np })
    });
    if (!res.ok) { alert("เปลี่ยนรหัสผ่านไม่สำเร็จ"); return; }
    alert("เปลี่ยนรหัสผ่านเรียบร้อย");
  }

  async function updateBranches(id: number, branchIds: number[]) {
    const res = await fetch(apiUrl(`/api/admin/staff/${id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch_ids: branchIds })
    });
    if (!res.ok) { alert("อัปเดตสาขาไม่สำเร็จ"); return; }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <button onClick={() => setCreating(!creating)} className="btn-primary">
        {creating ? "ยกเลิก" : "+ เพิ่มพนักงาน"}
      </button>

      {creating && (
        <form onSubmit={createUser} className="card space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label">ชื่อผู้ใช้ (สำหรับ login)</label>
              <input
                className="input" required minLength={3}
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </div>
            <div>
              <label className="label">ชื่อแสดง</label>
              <input
                className="input" required
                value={form.display_name}
                onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              />
            </div>
            <div>
              <label className="label">รหัสผ่าน</label>
              <input
                type="password" className="input" required minLength={6}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </div>
            <div>
              <label className="label">บทบาท</label>
              <select
                className="input" value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as "admin" | "staff" })}
              >
                <option value="staff">staff (ดูการจอง + กดสถานะ)</option>
                <option value="admin">admin (จัดการได้ทุกอย่าง)</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label">สาขาที่เข้าได้</label>
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
          <button className="btn-primary" disabled={busy}>{busy ? "กำลังบันทึก..." : "สร้างบัญชี"}</button>
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-2">ชื่อแสดง</th>
              <th>username</th>
              <th>บทบาท</th>
              <th>สาขา</th>
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
                  <button onClick={() => resetPassword(u.id)} className="text-xs text-brand mr-2">เปลี่ยนรหัส</button>
                  <button onClick={() => deleteUser(u.id, u.display_name)} className="text-xs text-red-600">ลบ</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
