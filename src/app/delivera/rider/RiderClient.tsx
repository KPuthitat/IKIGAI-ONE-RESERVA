"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";

// IKIGAI RIDER app. Registers via the rider LINE channel, heartbeats GPS while
// online (feeds "who's nearby" dispatch), lists this rider's jobs, and drives
// accept → picked up → delivered. window.liff typed globally in lib/liff-types.

type Job = {
  order_no: string; status: string; fulfillment: string;
  dest_address: string | null; dest_lat: number | null; dest_lng: number | null;
  customer_name: string | null; phone: string | null; total: number;
  pay_method: string | null; cod_amount: number; note: string | null;
  accepted: boolean; picked_up: boolean;
};

export default function RiderClient({ liffId, branchId }: { liffId: string; branchId: number }) {
  const [token, setToken] = useState("");
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const watchRef = useRef<number | null>(null);
  const tokenRef = useRef("");

  useEffect(() => {
    async function boot() {
      if (!liffId) { setErr("ยังไม่ได้ตั้งค่า LIFF ไรเดอร์"); return; }
      if (!branchId) { setErr("ลิงก์ไม่ถูกต้อง (ไม่มีรหัสสาขา)"); return; }
      for (let i = 0; i < 100 && !window.liff; i++) await new Promise((r) => setTimeout(r, 50));
      const liff = window.liff;
      if (!liff) { setErr("โหลด LINE SDK ไม่สำเร็จ"); return; }
      await liff.init({ liffId });
      if (!liff.isLoggedIn()) { liff.login(); return; }
      const t = liff.getAccessToken() ?? "";
      setToken(t); tokenRef.current = t;
      const res = await fetch(apiUrl("/api/delivera/rider/register"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: t, branch_id: branchId })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error === "rider_channel_not_configured" ? "ยังไม่ได้เปิดระบบไรเดอร์" : "ลงทะเบียนไม่สำเร็จ"); return; }
      setReady(true);
    }
    boot();
    return () => { if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current); };
  }, [liffId, branchId]);

  const loadJobs = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const res = await fetch(apiUrl(`/api/delivera/rider/jobs?token=${encodeURIComponent(tokenRef.current)}`), { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) setJobs(j.jobs);
    } catch { /* retry next tick */ }
  }, []);

  useEffect(() => {
    if (!ready) return;
    loadJobs();
    const t = setInterval(loadJobs, 10000);
    return () => clearInterval(t);
  }, [ready, loadJobs]);

  function toggleOnline() {
    if (online) {
      if (watchRef.current != null) { navigator.geolocation.clearWatch(watchRef.current); watchRef.current = null; }
      setOnline(false);
      return;
    }
    if (!navigator.geolocation) { setErr("อุปกรณ์ไม่รองรับ GPS"); return; }
    watchRef.current = navigator.geolocation.watchPosition(
      async (pos) => {
        await fetch(apiUrl("/api/delivera/rider/heartbeat"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access_token: tokenRef.current, lat: pos.coords.latitude, lng: pos.coords.longitude })
        }).catch(() => {});
      },
      () => setErr("เปิดตำแหน่งไม่สำเร็จ — อนุญาตการเข้าถึงตำแหน่ง"),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
    );
    setOnline(true);
  }

  async function jobAction(orderNo: string, action: "accept" | "pickup" | "deliver") {
    setBusy(orderNo + action);
    try {
      const res = await fetch(apiUrl(`/api/delivera/rider/jobs/${orderNo}`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: tokenRef.current, action })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr("ทำรายการไม่สำเร็จ"); return; }
      setErr(null); await loadJobs();
    } finally { setBusy(null); }
  }

  return (
    <div className="max-w-md mx-auto min-h-screen bg-white px-4 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-800">IKIGAI RIDER</h1>
        {ready && (
          <button type="button" onClick={toggleOnline}
            className={`rounded-full px-4 py-1.5 text-sm font-medium ${online ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600"}`}>
            {online ? "ออนไลน์ · แชร์ตำแหน่ง" : "ออฟไลน์"}
          </button>
        )}
      </div>
      {err && <p className="text-sm text-rose-600 mt-3">{err}</p>}
      {!ready && !err && <p className="text-sm text-slate-400 mt-4">กำลังเข้าสู่ระบบ…</p>}

      {ready && (
        <div className="mt-4 space-y-3">
          {jobs.length === 0 && <p className="text-sm text-slate-400">ยังไม่มีงานที่มอบหมาย</p>}
          {jobs.map((job) => (
            <div key={job.order_no} className="rounded-xl border border-slate-200 p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-bold text-slate-700">{job.order_no}</span>
                <span className="text-sm font-bold text-slate-800">฿{fmtMoney(job.total)}</span>
              </div>
              {job.dest_address && (
                <a href={job.dest_lat != null ? `https://www.google.com/maps/search/?api=1&query=${job.dest_lat},${job.dest_lng}` : undefined}
                  target="_blank" rel="noreferrer" className="mt-1 block text-sm text-brand underline">
                  {job.dest_address}
                </a>
              )}
              {job.phone && <a href={`tel:${job.phone}`} className="text-sm text-slate-600">โทร {job.phone}</a>}
              {job.pay_method === "cod" && job.cod_amount > 0 && (
                <p className="text-sm text-rose-600 font-medium mt-1">เก็บเงินปลายทาง ฿{fmtMoney(job.cod_amount)}</p>
              )}
              {job.note && <p className="text-[12px] text-amber-700 mt-1">หมายเหตุ: {job.note}</p>}

              <div className="mt-2">
                {!job.accepted && (
                  <button type="button" disabled={busy === job.order_no + "accept"} onClick={() => jobAction(job.order_no, "accept")}
                    className="w-full rounded-lg bg-brand text-white py-2.5 text-sm font-medium disabled:opacity-50">รับงาน</button>
                )}
                {job.accepted && !job.picked_up && (
                  <button type="button" disabled={busy === job.order_no + "pickup"} onClick={() => jobAction(job.order_no, "pickup")}
                    className="w-full rounded-lg bg-brand text-white py-2.5 text-sm font-medium disabled:opacity-50">รับของแล้ว</button>
                )}
                {job.picked_up && (
                  <button type="button" disabled={busy === job.order_no + "deliver"} onClick={() => jobAction(job.order_no, "deliver")}
                    className="w-full rounded-lg bg-emerald-600 text-white py-2.5 text-sm font-medium disabled:opacity-50">ส่งถึงแล้ว</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
