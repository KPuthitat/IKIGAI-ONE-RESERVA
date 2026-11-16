"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import BarcodeScanner from "@/app/components/BarcodeScanner";
import { apiUrl } from "@/lib/url";

type Test = { code: string; name_th: string };
type StationState = { code: string; name_th: string; passed: boolean; passed_at: string | null };
type Scan = { queue_id: number; label: string; code: string | null; payer: string | null; queue_no: number; appt_time: string | null; tests: Test[]; checked_in_at: string | null; checked_in_by: string | null; kind: "employee" | "external"; kit_no: string | null; stations: StationState[] };
type Row = { queue_id: number; key: string; kind: "employee" | "external"; label: string; code: string | null; payer: string | null; queue_no: number; appt_time: string | null; checked_in_at: string | null; checked_in_by: string | null; kit_no: string | null; stations_done: number; stations_total: number };
type Api = { ok: boolean; message?: string; scan?: Scan; already?: boolean };

const when = (iso: string) => new Date(iso.replace(" ", "T") + "Z").toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) + " น.";
async function post(path: string, body: unknown): Promise<Api> {
  try { return await (await fetch(apiUrl(`/api/annual-checkup/queue/${path}`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(); }
  catch { return { ok: false, message: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }; }
}

export default function QueueClient({ roundName, roster, stations }: { roundName: string; roster: Row[]; stations: Array<{ code: string; name_th: string }> }) {
  const router = useRouter();
  const [mode, setMode] = useState<"checkin" | "station">("checkin");
  const [station, setStation] = useState(stations[0]?.code ?? "");
  const [scanning, setScanning] = useState<null | "person" | "kit">(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [kit, setKit] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "waiting" | "arrived">("all");

  const onScanned = async (text: string) => {
    setMsg(null); setScan(null); setKit("");
    const r = await post("scan", { token: text });
    if (r.ok && r.scan) { setScan(r.scan); setToken(text); } else setMsg({ ok: false, text: r.message ?? "QR ไม่ถูกต้อง" });
  };
  const apply = (r: Api, okText: (s: Scan) => string, alreadyText: (s: Scan) => string) => {
    if (!r.ok) { setMsg({ ok: false, text: r.message ?? "ไม่สำเร็จ" }); return; }
    setScan(r.scan ?? null);
    setMsg(r.already ? { ok: false, text: alreadyText(r.scan as Scan) } : { ok: true, text: okText(r.scan as Scan) });
    router.refresh();
  };
  const confirmCheckIn = async (ref: { token: string } | { queueId: number }, kitNo: string) => {
    setBusy(true); setMsg(null);
    const r = await post("checkin", { ...ref, kitNo: kitNo.trim() || null });
    setBusy(false);
    apply(r, (s) => `เช็กอินแล้ว: ลำดับ ${s.queue_no} ${s.label}${s.kit_no ? ` · ชุด ${s.kit_no}` : ""}`, (s) => `เช็กอินไปแล้วเมื่อ ${s.checked_in_at ? when(s.checked_in_at) : ""} โดย ${s.checked_in_by ?? "—"}`);
  };
  const saveKit = async (queueId: number, kitNo: string) => {
    setBusy(true); setMsg(null);
    const r = await post("kit", { queueId, kitNo: kitNo.trim() });
    setBusy(false);
    apply(r, (s) => `บันทึกเลขชุด ${s.kit_no} ให้ลำดับ ${s.queue_no} แล้ว`, () => "");
  };
  const passHere = async (ref: { token: string } | { queueId: number }) => {
    setBusy(true); setMsg(null);
    const r = await post("station", { ...ref, station });
    setBusy(false);
    const nm = stations.find((x) => x.code === station)?.name_th ?? station;
    apply(r, (s) => `ผ่านสถานี ${nm} แล้ว: ลำดับ ${s.queue_no} ${s.label}`, (s) => `ผ่านสถานี ${nm} ไปแล้ว: ลำดับ ${s.queue_no}`);
  };

  const arrived = roster.filter((r) => r.checked_in_at).length;
  const shown = roster.filter((r) => filter === "all" || (filter === "arrived" ? !!r.checked_in_at : !r.checked_in_at));
  const route = scan?.stations ?? [];
  const here = route.find((x) => x.code === station);
  const stationName = stations.find((x) => x.code === station)?.name_th ?? "";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={mode === "checkin" ? "btn-primary text-sm" : "btn-secondary text-sm"} onClick={() => { setMode("checkin"); setScan(null); setMsg(null); }}>จุดลงทะเบียน (เช็กอิน)</button>
        <button type="button" className={mode === "station" ? "btn-primary text-sm" : "btn-secondary text-sm"} onClick={() => { setMode("station"); setScan(null); setMsg(null); }}>ประจำสถานี</button>
        {mode === "station" && (
          <select className="input" value={station} onChange={(e) => { setStation(e.target.value); setScan(null); setMsg(null); }} aria-label="สถานีที่ประจำ">
            {stations.map((s) => <option key={s.code} value={s.code}>{s.name_th}</option>)}
          </select>
        )}
      </div>
      <button type="button" className="btn-primary w-full md:w-auto text-base py-3" onClick={() => { setScanning("person"); setMsg(null); setScan(null); }}>
        {mode === "checkin" ? "สแกน QR เช็กอิน" : `สแกน QR ผ่านสถานี${stationName ? ` ${stationName}` : ""}`}
      </button>
      {scanning === "person" && <BarcodeScanner title="สแกน QR ของพนักงาน" onResult={onScanned} onClose={() => setScanning(null)} />}
      {scanning === "kit" && <BarcodeScanner title="สแกนบาร์โค้ดชุดเก็บตัวอย่าง" onResult={(t) => setKit(t.trim())} onClose={() => setScanning(null)} />}
      {msg && <div className={`rounded-lg px-4 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-amber-50 text-amber-900 border-amber-200"}`}>{msg.text}</div>}

      {scan && (
        <div className="card p-4 space-y-3">
          <div className="flex items-baseline gap-3"><div className="text-5xl font-extrabold text-brand tabular-nums">{scan.queue_no}</div><div><div className="text-lg font-semibold text-slate-800">{scan.label}</div><div className="text-xs text-slate-500">{scan.code ?? "ผู้เข้าตรวจภายนอก"} · {scan.payer ?? "—"}</div></div></div>
          {scan.kit_no && <div className="text-sm text-slate-700">หมายเลขชุดเก็บตัวอย่าง: <b className="tabular-nums">{scan.kit_no}</b></div>}

          {mode === "checkin" && (
            <>
              <ul className="text-sm text-slate-800 list-disc pl-5">{scan.tests.map((t) => <li key={t.code}>{t.name_th}</li>)}</ul>
              {route.length > 0 && <div className="text-sm text-slate-600">สถานีที่ต้องไป: {route.map((x) => x.name_th).join(" → ")}</div>}
              {(!scan.checked_in_at || !scan.kit_no) && (
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-slate-700">หมายเลขชุดเก็บตัวอย่าง (ป้ายหลอดที่เตรียมไว้)</div>
                  <div className="flex flex-wrap gap-2">
                    <input className="input w-48" value={kit} onChange={(e) => setKit(e.target.value)} placeholder="พิมพ์หรือสแกนเลขชุด" aria-label="หมายเลขชุดเก็บตัวอย่าง" />
                    <button type="button" className="btn-secondary text-sm" onClick={() => setScanning("kit")}>สแกนบาร์โค้ด</button>
                  </div>
                </div>
              )}
              {scan.checked_in_at ? (
                <div className="space-y-2">
                  <div className="text-sm text-emerald-700">เช็กอินแล้ว {when(scan.checked_in_at)} โดย {scan.checked_in_by}</div>
                  <button type="button" className="btn-secondary text-sm" disabled={busy || !kit.trim()} onClick={() => saveKit(scan.queue_id, kit)}>{scan.kit_no ? "แก้เลขชุด" : "บันทึกเลขชุด"}</button>
                </div>
              ) : token && (
                <button type="button" className="btn-primary" disabled={busy || !kit.trim()} onClick={() => confirmCheckIn({ token }, kit)}>ยืนยันเช็กอิน{!kit.trim() ? " (ใส่เลขชุดก่อน)" : ""}</button>
              )}
            </>
          )}

          {mode === "station" && (
            <>
              {!scan.checked_in_at ? <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2">ยังไม่ได้เช็กอิน ส่งไปที่จุดลงทะเบียนก่อน</div> : (
                <>
                  <ol className="space-y-1">
                    {route.map((x, i) => (
                      <li key={x.code} className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${x.code === station ? "border-brand" : "border-slate-200"} ${x.passed ? "bg-emerald-50 text-emerald-800" : ""}`}>
                        <span className="w-5 text-xs font-bold">{x.passed ? "✓" : i + 1}</span><span className="grow">{x.name_th}</span><span className="text-xs">{x.passed ? "ผ่านแล้ว" : "ยังไม่ได้ตรวจ"}</span>
                      </li>
                    ))}
                  </ol>
                  {!here ? <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2">สถานี {stationName} ไม่อยู่ในรายการตรวจของคนนี้</div>
                    : here.passed ? <div className="text-sm text-emerald-700">ผ่านสถานีนี้แล้ว{here.passed_at ? ` เมื่อ ${when(here.passed_at)}` : ""}</div>
                    : <button type="button" className="btn-primary" disabled={busy} onClick={() => passHere({ queueId: scan.queue_id })}>ยืนยันผ่านสถานี {stationName}</button>}
                </>
              )}
            </>
          )}
        </div>
      )}

      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <div className="text-sm font-semibold text-slate-800 mr-2">{roundName} · มาแล้ว {arrived}/{roster.length}</div>
          {([["all", "ทั้งหมด"], ["waiting", "ยังไม่มา"], ["arrived", "มาแล้ว"]] as const).map(([v, th]) => <button key={v} type="button" className={`chip ${filter === v ? "chip-active" : ""}`} onClick={() => setFilter(v)}>{th}</button>)}
        </div>
        <table className="w-full text-sm min-w-[640px]">
          <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1 pr-3">ลำดับ</th><th className="py-1 pr-3">ชื่อ</th><th className="py-1 pr-3">เวลานัด</th><th className="py-1 pr-3">เลขชุด</th><th className="py-1 pr-3">สถานี</th><th className="py-1 pr-3">สถานะ</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.queue_id} className="border-b border-slate-100 last:border-0">
                <td className="py-1.5 pr-3 font-bold tabular-nums">{r.queue_no}</td>
                <td className="py-1.5 pr-3"><div className="font-medium text-slate-800">{r.label}</div><div className="text-[11px] text-slate-400">{r.code ?? "ผู้เข้าตรวจภายนอก"}</div></td>
                <td className="py-1.5 pr-3 text-slate-600">{r.appt_time ?? "—"}</td>
                <td className="py-1.5 pr-3 tabular-nums">{r.kit_no ?? "—"}</td>
                <td className="py-1.5 pr-3 tabular-nums text-slate-600">{r.checked_in_at ? `${r.stations_done}/${r.stations_total}` : "—"}</td>
                <td className="py-1.5 pr-3">
                  {r.checked_in_at ? <span className="rounded px-1.5 py-0.5 text-[11px] bg-emerald-100 text-emerald-700">มาแล้ว {when(r.checked_in_at)}</span>
                    : <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => { const k = window.prompt("หมายเลขชุดเก็บตัวอย่าง (เว้นว่างได้)", "") ?? null; if (k !== null) confirmCheckIn({ queueId: r.queue_id }, k); }}>{r.kind === "external" ? "เช็กอินด้วยมือ" : "ยังไม่มา · เช็กอินด้วยมือ"}</button>}
                </td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={6} className="py-3 text-slate-500">ไม่มีรายการ</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
