"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { post } from "../shared";

export default function ReleaseCompany({ roundId, payers, unlocked }: { roundId: number; payers: Array<{ id: number; name: string }>; unlocked: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; text: string; skipped: Array<{ label: string; reason: string }> } | null>(null);
  async function go(p: { id: number; name: string }) {
    if (!window.confirm(`เปิดผลให้ทุกคนของ ${p.name} ที่พร้อม (มีสรุปของแพทย์และตรวจสอบครบ) ใช่หรือไม่?\nคนที่ยังไม่พร้อมจะถูกข้ามและแสดงเหตุผล`)) return;
    setBusy(true); setRes(null);
    const r = await post("release-company", { roundId, payerId: p.id });
    setBusy(false);
    if (!r.ok) { setRes({ ok: false, text: r.message ?? "ไม่สำเร็จ", skipped: [] }); return; }
    setRes({ ok: true, text: `เปิดผลแล้ว ${r.people} คน (${r.released} รายการ)`, skipped: (r.skipped as Array<{ label: string; reason: string }>) ?? [] }); router.refresh();
  }
  return (
    <div className="card space-y-2">
      <div className="text-sm font-semibold text-slate-800">เปิดผลทั้งบริษัท (แพทย์ผู้อนุมัติ)</div>
      {!unlocked && <p className="text-xs text-slate-500">ปลดล็อกด้วยเลขใบอนุญาตที่หน้าผู้เข้ารับการตรวจก่อน</p>}
      <div className="flex flex-wrap gap-2">{payers.map((p) => <button key={p.id} type="button" disabled={busy || !unlocked} className="btn-secondary min-h-[44px] px-4 text-sm" onClick={() => go(p)}>เปิดผล: {p.name}</button>)}</div>
      {res && <div className={`text-sm ${res.ok ? "text-emerald-800" : "text-rose-700"}`}>{res.text}{res.skipped.length > 0 && <ul className="mt-1 text-xs text-slate-600 list-disc pl-5">{res.skipped.map((s, i) => <li key={i}>{s.label}: {s.reason}</li>)}</ul>}</div>}
    </div>
  );
}
