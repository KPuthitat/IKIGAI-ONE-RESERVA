"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { ClinicPerson } from "@/lib/annual-checkup-db";

async function call(body: Record<string, unknown>): Promise<{ ok: boolean; message?: string; people?: Array<{ id: number; name: string; employee_code: string | null; branches: string }> }> {
  try { return await (await fetch(apiUrl("/api/admin/persona/annual-checkup/permissions"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(); }
  catch { return { ok: false, message: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }; }
}

export default function PermissionsClient({ people }: { people: ClinicPerson[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Array<{ id: number; name: string; employee_code: string | null; branches: string }> | null>(null);

  async function toggle(p: ClinicPerson, cap: "recorder" | "approver") {
    const on = cap === "recorder" ? p.recorder : p.approver;
    const label = cap === "recorder" ? "เจ้าหน้าที่กรอกผล" : "แพทย์ผู้อนุมัติ";
    const reason = window.prompt(`${on ? "ถอน" : "ให้"}สิทธิ์ "${label}" ของ ${p.name}\nระบุเหตุผล (บันทึกในประวัติ):`);
    if (!reason || !reason.trim()) return;
    setBusy(true); setMsg(null);
    const r = await call({ action: on ? "revoke" : "grant", userId: p.id, capability: cap, reason: reason.trim() });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.message ?? "ไม่สำเร็จ" }); return; }
    setMsg({ ok: true, text: `${on ? "ถอน" : "ให้"}สิทธิ์ ${label} ของ ${p.name} แล้ว` }); router.refresh();
  }
  async function search() { setBusy(true); const r = await call({ action: "search", q }); setBusy(false); setFound(r.people ?? []); }
  async function add(p: { id: number; name: string }) {
    const reason = window.prompt(`เพิ่ม ${p.name} เข้าสาขา AT HOME CLINIC เพื่อให้รับสิทธิ์ได้\nระบุเหตุผล (บันทึกในประวัติ):`);
    if (!reason || !reason.trim()) return;
    setBusy(true);
    const r = await call({ action: "add_to_clinic", userId: p.id, reason: reason.trim() });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.message ?? "ไม่สำเร็จ" }); return; }
    setMsg({ ok: true, text: `เพิ่ม ${p.name} เข้าสาขา AT HOME CLINIC แล้ว` }); setFound(null); setQ(""); router.refresh();
  }

  return (
    <div className="space-y-4">
      {msg && <div role="status" className={`rounded-lg px-4 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-rose-50 text-rose-800 border-rose-200"}`}>{msg.text}</div>}
      <div className="card divide-y divide-slate-100">
        <div className="px-1 pb-2 font-semibold text-slate-800">พนักงานสาขา AT HOME CLINIC ({people.length} คน)</div>
        {people.map((p) => (
          <div key={p.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0"><div className="text-sm font-medium text-slate-800">{p.name}</div><div className="text-xs text-slate-500">{p.employee_code ?? "—"}{p.clinical_role ? ` · ${p.clinical_role === "doctor" ? "แพทย์" : p.clinical_role}` : ""}{p.approver_blocker && !p.approver ? ` · อนุมัติไม่ได้: ${p.approver_blocker}` : ""}</div></div>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => toggle(p, "recorder")} className={`min-h-[44px] px-3 rounded-lg border text-sm ${p.recorder ? "bg-emerald-600 text-white border-emerald-600" : "bg-white border-slate-300 text-slate-700"}`}>{p.recorder ? "✓ " : ""}กรอกผล</button>
              <button type="button" disabled={busy || (!p.approver && !!p.approver_blocker)} title={p.approver_blocker ?? ""} onClick={() => toggle(p, "approver")} className={`min-h-[44px] px-3 rounded-lg border text-sm disabled:opacity-50 ${p.approver ? "bg-emerald-600 text-white border-emerald-600" : "bg-white border-slate-300 text-slate-700"}`}>{p.approver ? "✓ " : ""}แพทย์อนุมัติ</button>
            </div>
          </div>
        ))}
        {people.length === 0 && <p className="text-sm text-slate-500 py-2">ยังไม่มีพนักงานในสาขา AT HOME CLINIC</p>}
      </div>
      <div className="card space-y-2">
        <div className="font-semibold text-slate-800">เพิ่มคนจากสาขาอื่น (เลือกเอง)</div>
        <p className="text-xs text-slate-500">สิทธิ์ใช้ได้เฉพาะคนที่อยู่สาขา AT HOME CLINIC ถ้าต้องการให้สิทธิ์คนสาขาอื่น ให้เพิ่มเข้าสาขานี้ก่อน (ต้องใส่เหตุผล เก็บประวัติ) แล้วจึงกดให้สิทธิ์ในรายการด้านบน</p>
        <div className="flex gap-2"><input className="input min-h-[44px] flex-1" placeholder="ค้นหาชื่อหรือรหัสพนักงาน (อย่างน้อย 2 ตัวอักษร)" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") search(); }} /><button type="button" className="btn-secondary min-h-[44px] px-4" disabled={busy || q.trim().length < 2} onClick={search}>ค้นหา</button></div>
        {found && (found.length === 0 ? <p className="text-sm text-slate-500">ไม่พบ</p> : <ul className="divide-y divide-slate-100">{found.map((f) => <li key={f.id} className="py-1.5 flex items-center justify-between gap-2"><span className="text-sm">{f.name} <span className="text-xs text-slate-500">{f.employee_code ?? ""} · {f.branches}</span></span><button type="button" className="btn-secondary min-h-[44px] px-3 text-sm" disabled={busy} onClick={() => add(f)}>เพิ่มเข้าสาขา AT HOME CLINIC</button></li>)}</ul>)}
      </div>
    </div>
  );
}
