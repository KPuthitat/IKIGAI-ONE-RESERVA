"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type Station = { id: number; code: string; name_th: string; sort_no: number; active: number };
type TestRow = { code: string; name_th: string; station_id: number | null };
type Res = { ok: boolean; message?: string };

async function call(body: unknown): Promise<Res> {
  try { return await (await fetch(apiUrl("/api/admin/persona/annual-checkup/stations"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(); }
  catch { return { ok: false, message: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }; }
}

export default function StationsEditor({ stations, tests }: { stations: Station[]; tests: TestRow[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<number, { name: string; sort: string; active: boolean }>>({});
  const [nw, setNw] = useState({ code: "", name: "", sort: String((stations.at(-1)?.sort_no ?? 0) + 1) });
  const val = (s: Station) => draft[s.id] ?? { name: s.name_th, sort: String(s.sort_no), active: s.active === 1 };
  const run = async (body: unknown, ok: string) => {
    setBusy(true); setMsg(null);
    const r = await call(body);
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: ok } : { ok: false, text: r.message ?? "ไม่สำเร็จ" });
    if (r.ok) router.refresh();
    return r.ok;
  };
  return (
    <div className="space-y-4">
      {msg && <div className={`rounded-lg px-3 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-rose-50 text-rose-800 border-rose-200"}`}>{msg.text}</div>}
      <div className="card overflow-x-auto">
        <div className="text-sm font-semibold text-slate-800 mb-2">สถานี</div>
        <table className="w-full text-sm min-w-[560px]">
          <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1 pr-3">ลำดับที่ไป</th><th className="py-1 pr-3">ชื่อสถานี</th><th className="py-1 pr-3">ใช้งาน</th><th /></tr></thead>
          <tbody>
            {stations.map((s) => {
              const v = val(s);
              return (
                <tr key={s.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 pr-3"><input className="input w-16" inputMode="numeric" value={v.sort} onChange={(e) => setDraft((d) => ({ ...d, [s.id]: { ...v, sort: e.target.value.replace(/\D/g, "") } }))} aria-label={`ลำดับของ ${s.name_th}`} /></td>
                  <td className="py-1.5 pr-3"><input className="input w-full" value={v.name} onChange={(e) => setDraft((d) => ({ ...d, [s.id]: { ...v, name: e.target.value } }))} aria-label={`ชื่อสถานี ${s.code}`} /><div className="text-[11px] text-slate-400">{s.code}</div></td>
                  <td className="py-1.5 pr-3"><input type="checkbox" checked={v.active} onChange={(e) => setDraft((d) => ({ ...d, [s.id]: { ...v, active: e.target.checked } }))} aria-label={`ใช้งาน ${s.name_th}`} /></td>
                  <td className="py-1.5"><button type="button" className="btn-primary text-xs" disabled={busy || !draft[s.id]} onClick={async () => { if (await run({ action: "save", id: s.id, nameTh: v.name, sortNo: Number(v.sort) || 0, active: v.active }, `บันทึก ${v.name} แล้ว`)) setDraft((d) => { const n = { ...d }; delete n[s.id]; return n; }); }}>บันทึก</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
          <div><div className="text-xs text-slate-500">รหัส (อังกฤษ)</div><input className="input w-28" value={nw.code} onChange={(e) => setNw({ ...nw, code: e.target.value.toUpperCase() })} placeholder="เช่น ECG" /></div>
          <div className="grow"><div className="text-xs text-slate-500">ชื่อสถานีใหม่</div><input className="input w-full" value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} /></div>
          <div><div className="text-xs text-slate-500">ลำดับ</div><input className="input w-16" inputMode="numeric" value={nw.sort} onChange={(e) => setNw({ ...nw, sort: e.target.value.replace(/\D/g, "") })} /></div>
          <button type="button" className="btn-secondary text-sm" disabled={busy || !nw.code || !nw.name} onClick={async () => { if (await run({ action: "save", code: nw.code, nameTh: nw.name, sortNo: Number(nw.sort) || 0, active: true }, "เพิ่มสถานีแล้ว")) setNw({ code: "", name: "", sort: String(Number(nw.sort) + 1) }); }}>เพิ่มสถานี</button>
        </div>
      </div>
      <div className="card overflow-x-auto">
        <div className="text-sm font-semibold text-slate-800 mb-2">รายการตรวจแต่ละอย่างอยู่สถานีไหน</div>
        <table className="w-full text-sm min-w-[480px]">
          <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1 pr-3">รายการตรวจ</th><th className="py-1">สถานี</th></tr></thead>
          <tbody>
            {tests.map((t) => (
              <tr key={t.code} className="border-b border-slate-100 last:border-0">
                <td className="py-1.5 pr-3 text-slate-800">{t.name_th}</td>
                <td className="py-1.5">
                  <select className="input" disabled={busy} value={t.station_id ?? ""} aria-label={`สถานีของ ${t.name_th}`} onChange={(e) => run({ action: "assign", testCode: t.code, stationId: e.target.value ? Number(e.target.value) : null }, `ย้าย ${t.name_th} แล้ว`)}>
                    <option value="">ไม่มีสถานี</option>
                    {stations.map((s) => <option key={s.id} value={s.id}>{s.name_th}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
