"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";

export type AccessRow = {
  id: number; username: string; display_name: string; title_prefix: string | null;
  role: "super_admin" | "admin" | "staff";
  clinical_role: "doctor" | "nurse" | null;
  license_no: string | null;
  is_hr_analytics: number;
};

export default function AccessClient({ rows }: { rows: AccessRow[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-slate-500 border-b">
          <th className="py-2 pr-3">พนักงาน</th>
          <th className="py-2 pr-3">บทบาททางคลินิก</th>
          <th className="py-2 pr-3">เลขใบประกอบวิชาชีพ</th>
          <th className="py-2 pr-3 text-center">HR (ภาพรวม)</th>
          <th className="py-2 pr-3"></th>
        </tr></thead>
        <tbody>
          {rows.map((r) => <Row key={r.id} row={r} />)}
          {rows.length === 0 && (
            <tr><td colSpan={5} className="py-6 text-center text-slate-400">ไม่มีพนักงาน</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Row({ row }: { row: AccessRow }) {
  const router = useRouter();
  const [role, setRole] = useState<"none" | "doctor" | "nurse">(row.clinical_role ?? "none");
  const [license, setLicense] = useState(row.license_no ?? "");
  const [hr, setHr] = useState(row.is_hr_analytics === 1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const dirty = role !== (row.clinical_role ?? "none")
    || license !== (row.license_no ?? "")
    || hr !== (row.is_hr_analytics === 1);

  async function save() {
    if (role === "doctor" && license.trim() === "") {
      setMsg("แพทย์ต้องระบุเลขใบประกอบ"); return;
    }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/mounjaro/access"), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: row.id,
          clinical_role: role === "none" ? null : role,
          license_no: license.trim() || null,
          is_hr_analytics: hr ? 1 : 0
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg(j.error === "license_required_for_doctor" ? "แพทย์ต้องระบุเลขใบประกอบ" : "บันทึกไม่สำเร็จ");
        return;
      }
      setMsg("บันทึกแล้ว");
      router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <tr className="border-b last:border-0">
      <td className="py-2 pr-3">
        <div className="font-medium text-slate-800">{nameWithPrefix(row.title_prefix, row.display_name)}</div>
        <div className="text-xs text-slate-400">@{row.username}</div>
      </td>
      <td className="py-2 pr-3">
        <select className="input !py-1.5 text-sm !w-auto" value={role}
          onChange={(e) => setRole(e.target.value as "none" | "doctor" | "nurse")}>
          <option value="none">— ไม่มี —</option>
          <option value="doctor">แพทย์</option>
          <option value="nurse">พยาบาล</option>
        </select>
      </td>
      <td className="py-2 pr-3">
        <input className="input !py-1.5 text-sm" value={license}
          onChange={(e) => setLicense(e.target.value)}
          placeholder={role === "doctor" ? "จำเป็น เช่น ว.12345" : "เช่น พย.6789"}
          disabled={role === "none"} />
      </td>
      <td className="py-2 pr-3 text-center">
        <input type="checkbox" checked={hr} onChange={(e) => setHr(e.target.checked)} />
      </td>
      <td className="py-2 pr-3 text-right whitespace-nowrap">
        {msg && <span className={`text-[11px] mr-2 ${msg === "บันทึกแล้ว" ? "text-emerald-600" : "text-rose-600"}`}>{msg}</span>}
        <button type="button" onClick={save} disabled={busy || !dirty}
          className="text-xs px-3 py-1.5 rounded-md bg-brand text-white font-bold disabled:opacity-40">
          {busy ? "…" : "บันทึก"}
        </button>
      </td>
    </tr>
  );
}
