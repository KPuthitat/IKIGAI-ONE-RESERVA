"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import BarcodeScanner from "@/app/components/BarcodeScanner";
import { apiUrl } from "@/lib/url";

type Test = { code: string; name_th: string };
type Scan = { queue_id: number; label: string; code: string | null; payer: string | null; queue_no: number; appt_time: string | null; tests: Test[]; checked_in_at: string | null; checked_in_by: string | null; kind: "employee" | "external" };
type Row = { queue_id: number; key: string; kind: "employee" | "external"; label: string; code: string | null; payer: string | null; queue_no: number; appt_time: string | null; checked_in_at: string | null; checked_in_by: string | null };
type Api = { ok: boolean; message?: string; scan?: Scan; already?: boolean };

const when = (iso: string) => new Date(iso.replace(" ", "T") + "Z").toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) + " น.";
async function post(path: string, body: unknown): Promise<Api> {
  try { return await (await fetch(apiUrl(`/api/annual-checkup/queue/${path}`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(); }
  catch { return { ok: false, message: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }; }
}

export default function QueueClient({ roundName, roster }: { roundName: string; roster: Row[] }) {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<Scan | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "waiting" | "arrived">("all");

  const onScanned = async (text: string) => {
    setMsg(null); setScan(null);
    const r = await post("scan", { token: text });
    if (r.ok && r.scan) { setScan(r.scan); setToken(text); } else setMsg({ ok: false, text: r.message ?? "QR ไม่ถูกต้อง" });
  };
  const confirm = async (ref: { token: string } | { queueId: number }) => {
    setBusy(true); setMsg(null);
    const r = await post("checkin", ref);
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.message ?? "เช็กอินไม่สำเร็จ" }); return; }
    setScan(r.scan ?? null);
    setMsg(r.already
      ? { ok: false, text: `เช็กอินไปแล้วเมื่อ ${r.scan?.checked_in_at ? when(r.scan.checked_in_at) : ""} โดย ${r.scan?.checked_in_by ?? "—"}` }
      : { ok: true, text: `เช็กอินแล้ว: ลำดับ ${r.scan?.queue_no} ${r.scan?.label}` });
    router.refresh();
  };

  const arrived = roster.filter((r) => r.checked_in_at).length;
  const shown = roster.filter((r) => filter === "all" || (filter === "arrived" ? !!r.checked_in_at : !r.checked_in_at));
  return (
    <div className="space-y-4">
      <button type="button" className="btn-primary w-full md:w-auto text-base py-3" onClick={() => { setScanning(true); setMsg(null); setScan(null); }}>สแกน QR เช็กอิน</button>
      {scanning && <BarcodeScanner title="สแกน QR ของพนักงาน" onResult={onScanned} onClose={() => setScanning(false)} />}
      {msg && <div className={`rounded-lg px-4 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-amber-50 text-amber-900 border-amber-200"}`}>{msg.text}</div>}
      {scan && (
        <div className="card p-4 space-y-2">
          <div className="flex items-baseline gap-3"><div className="text-5xl font-extrabold text-brand tabular-nums">{scan.queue_no}</div><div><div className="text-lg font-semibold text-slate-800">{scan.label}</div><div className="text-xs text-slate-500">{scan.code ?? "ผู้เข้าตรวจภายนอก"} · {scan.payer ?? "—"}</div></div></div>
          <ul className="text-sm text-slate-800 list-disc pl-5">{scan.tests.map((t) => <li key={t.code}>{t.name_th}</li>)}</ul>
          {scan.checked_in_at
            ? <div className="text-sm text-emerald-700">เช็กอินแล้ว {when(scan.checked_in_at)} โดย {scan.checked_in_by}</div>
            : token && <button type="button" className="btn-primary" disabled={busy} onClick={() => confirm({ token })}>ยืนยันเช็กอิน</button>}
        </div>
      )}
      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <div className="text-sm font-semibold text-slate-800 mr-2">{roundName} · มาแล้ว {arrived}/{roster.length}</div>
          {([["all", "ทั้งหมด"], ["waiting", "ยังไม่มา"], ["arrived", "มาแล้ว"]] as const).map(([v, th]) => <button key={v} type="button" className={`chip ${filter === v ? "chip-active" : ""}`} onClick={() => setFilter(v)}>{th}</button>)}
        </div>
        <table className="w-full text-sm min-w-[520px]">
          <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1 pr-3">ลำดับ</th><th className="py-1 pr-3">ชื่อ</th><th className="py-1 pr-3">เวลานัด</th><th className="py-1 pr-3">สถานะ</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.queue_id} className="border-b border-slate-100 last:border-0">
                <td className="py-1.5 pr-3 font-bold tabular-nums">{r.queue_no}</td>
                <td className="py-1.5 pr-3"><div className="font-medium text-slate-800">{r.label}</div><div className="text-[11px] text-slate-400">{r.code ?? "ผู้เข้าตรวจภายนอก"}</div></td>
                <td className="py-1.5 pr-3 text-slate-600">{r.appt_time ?? "—"}</td>
                <td className="py-1.5 pr-3">
                  {r.checked_in_at ? <span className="rounded px-1.5 py-0.5 text-[11px] bg-emerald-100 text-emerald-700">มาแล้ว {when(r.checked_in_at)}</span>
                    : <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => confirm({ queueId: r.queue_id })}>{r.kind === "external" ? "เช็กอินด้วยมือ" : "ยังไม่มา · เช็กอินด้วยมือ"}</button>}
                </td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={4} className="py-3 text-slate-500">ไม่มีรายการ</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
