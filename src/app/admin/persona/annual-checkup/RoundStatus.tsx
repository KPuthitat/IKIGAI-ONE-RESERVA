"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type R = { id: number; name: string; status: string; people: number; yearBe: number | null; startDate: string | null; endDate: string | null; location: string | null };
const LABEL: Record<string, string> = { draft: "ร่าง (พนักงานยังไม่เห็น)", open: "เปิดอยู่ (พนักงานเห็นหมายเลขและ QR)", closed: "ปิดแล้ว" };
const CLS: Record<string, string> = { draft: "bg-amber-100 text-amber-800", open: "bg-emerald-100 text-emerald-800", closed: "bg-slate-200 text-slate-700" };

async function post(body: unknown): Promise<{ ok: boolean; message?: string }> {
  try { return await (await fetch(apiUrl("/api/admin/persona/annual-checkup/round"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(); }
  catch { return { ok: false, message: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }; }
}

// Manage the rounds: open / close (employees see their number and QR only while open), edit the name / dates / place, and delete a round that was
// imported by mistake (only while it holds no health data and nobody has checked in — the server refuses otherwise and says why).
export default function RoundStatus({ rounds }: { rounds: R[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [edit, setEdit] = useState<number | null>(null);
  const [del, setDel] = useState<number | null>(null);
  const [f, setF] = useState({ name: "", yearBe: "", startDate: "", endDate: "", location: "" });
  const [confirmName, setConfirmName] = useState("");

  async function run(id: number, body: unknown, after?: () => void) {
    setBusy(id); setMsg(null);
    const j = await post(body);
    setBusy(null);
    if (!j.ok) { setMsg(j.message ?? "ไม่สำเร็จ"); return; }
    after?.(); router.refresh();
  }
  const startEdit = (r: R) => { setDel(null); setEdit(r.id); setMsg(null); setF({ name: r.name, yearBe: r.yearBe ? String(r.yearBe) : "", startDate: r.startDate ?? "", endDate: r.endDate ?? "", location: r.location ?? "" }); };

  if (rounds.length === 0) return null;
  return (
    <div className="card p-4 space-y-2">
      <div className="font-semibold text-slate-800">รอบตรวจ</div>
      <ul className="divide-y divide-slate-100">
        {rounds.map((r) => (
          <li key={r.id} className="py-3 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <div className="grow min-w-[10rem]"><div className="font-medium text-slate-800">{r.name}</div><div className="text-xs text-slate-500">{r.people} คน{r.startDate ? ` · ${r.startDate}` : ""}{r.location ? ` · ${r.location}` : ""}</div></div>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${CLS[r.status] ?? ""}`}>{LABEL[r.status] ?? r.status}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {r.status !== "open" && <button type="button" disabled={busy === r.id} onClick={() => run(r.id, { roundId: r.id, status: "open" })} className="btn-primary text-sm">เปิดรอบ</button>}
              {r.status === "open" && <button type="button" disabled={busy === r.id} onClick={() => run(r.id, { roundId: r.id, status: "closed" })} className="btn-secondary text-sm">ปิดรอบ</button>}
              <button type="button" onClick={() => (edit === r.id ? setEdit(null) : startEdit(r))} className="btn-secondary text-sm">แก้ไขข้อมูลรอบ</button>
              <button type="button" onClick={() => { setEdit(null); setDel(del === r.id ? null : r.id); setConfirmName(""); setMsg(null); }} className="rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50">ลบรอบ</button>
            </div>
            {edit === r.id && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 grid gap-3 sm:grid-cols-2">
                <label className="block text-sm sm:col-span-2"><span className="label">ชื่อรอบ</span><input className="input w-full" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
                <label className="block text-sm"><span className="label">ปี พ.ศ.</span><input className="input w-full" inputMode="numeric" value={f.yearBe} onChange={(e) => setF({ ...f, yearBe: e.target.value })} /></label>
                <label className="block text-sm"><span className="label">สถานที่ตรวจ</span><input className="input w-full" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></label>
                <label className="block text-sm"><span className="label">วันตรวจ (เริ่ม)</span><input type="date" className="input w-full" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
                <label className="block text-sm"><span className="label">วันตรวจ (สิ้นสุด)</span><input type="date" className="input w-full" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
                <div className="sm:col-span-2 flex gap-2">
                  <button type="button" disabled={busy === r.id} className="btn-primary text-sm"
                    onClick={() => run(r.id, { roundId: r.id, action: "update", name: f.name, yearBe: f.yearBe ? Number(f.yearBe) : null, startDate: f.startDate || null, endDate: f.endDate || null, location: f.location || null }, () => setEdit(null))}>บันทึก</button>
                  <button type="button" className="btn-secondary text-sm" onClick={() => setEdit(null)}>ยกเลิก</button>
                </div>
              </div>
            )}
            {del === r.id && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 space-y-2 text-sm">
                <p className="text-rose-900">ลบรอบนี้พร้อมรายชื่อ รายการตรวจ และลำดับคิวทั้งหมดของรอบ ทำได้เฉพาะรอบที่ปิดอยู่ ไม่มีผลตรวจ และยังไม่มีใครเช็กอิน ลบแล้วกู้คืนไม่ได้ (ต้องนำเข้าไฟล์ใหม่)</p>
                <label className="block"><span className="label">พิมพ์ชื่อรอบเพื่อยืนยัน: <b>{r.name}</b></span><input className="input w-full" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} /></label>
                <div className="flex gap-2">
                  <button type="button" disabled={busy === r.id || confirmName.trim() !== r.name.trim()} className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
                    onClick={() => run(r.id, { roundId: r.id, action: "delete", confirmName }, () => setDel(null))}>ยืนยันลบรอบ</button>
                  <button type="button" className="btn-secondary text-sm" onClick={() => setDel(null)}>ยกเลิก</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {msg && <p className="text-sm text-rose-600" role="alert">{msg}</p>}
    </div>
  );
}
