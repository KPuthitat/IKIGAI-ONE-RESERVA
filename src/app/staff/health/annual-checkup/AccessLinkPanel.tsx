"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { post } from "./shared";
import type { LinkInfo } from "@/lib/annual-checkup-db";

const when = (s: string) => new Date(s.replace(" ", "T") + "Z").toLocaleString("th-TH", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

export default function AccessLinkPanel({ roundId, externalId, links, hasDob }: { roundId: number; externalId: number; links: LinkInfo[]; hasDob: boolean }) {
  const router = useRouter();
  const [days, setDays] = useState(14);
  const [url, setUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  async function create() {
    setBusy(true); setMsg(null); setUrl(null);
    const r = await post("access-link", { action: "create", roundId, externalId, days });
    setBusy(false);
    if (!r.ok) { setMsg(r.error === "dob_required" ? "ยังไม่มีวันเกิดของคนนี้ กรุณาใส่วันเกิดก่อน" : r.message ?? "สร้างลิงก์ไม่สำเร็จ"); return; }
    setUrl(r.url as string); router.refresh();
  }
  async function revoke(id: number) { if (!window.confirm("ยกเลิกลิงก์นี้?")) return; await post("access-link", { action: "revoke", linkId: id }); router.refresh(); }
  return (
    <div className="card space-y-2">
      <div className="font-semibold text-slate-800">ลิงก์ดูผลสำหรับผู้ที่ไม่มีบัญชี</div>
      <p className="text-xs text-slate-500">สร้างลิงก์เฉพาะคนนี้ ส่งให้เจ้าตัว เปิดได้เมื่อกรอกวันเดือนปีเกิดถูกต้อง หมดอายุตามที่เลือก กรอกผิด 5 ครั้งล็อก 30 นาที ลิงก์แสดงให้เห็นครั้งเดียว</p>
      {!hasDob && <p className="text-sm text-amber-800">ยังไม่มีวันเกิดของคนนี้ในระบบ จึงสร้างลิงก์ไม่ได้</p>}
      <div className="flex flex-wrap items-center gap-2">
        <select className="input min-h-[44px]" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[3, 7, 14, 30, 60, 90].map((n) => <option key={n} value={n}>หมดอายุใน {n} วัน</option>)}</select>
        <button type="button" className="btn-primary min-h-[44px] px-4" disabled={busy || !hasDob} onClick={create}>สร้างลิงก์ใหม่</button>
      </div>
      {msg && <div className="text-sm text-rose-700">{msg}</div>}
      {url && <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm break-all"><b>ลิงก์ (คัดลอกตอนนี้ จะไม่แสดงอีก):</b><div className="font-mono text-xs mt-1 select-all">{url}</div></div>}
      {links.length > 0 && (
        <ul className="text-sm divide-y divide-slate-100">
          {links.map((l) => {
            const st = l.revoked_at ? "ยกเลิกแล้ว" : l.expires_at <= now ? "หมดอายุ" : l.locked_until && l.locked_until > now ? "ถูกล็อกชั่วคราว" : "ใช้ได้";
            return <li key={l.id} className="py-1.5 flex flex-wrap items-center justify-between gap-2"><span>สร้าง {when(l.created_at)} · หมดอายุ {when(l.expires_at)} · เปิดแล้ว {l.open_count} ครั้ง · <b>{st}</b></span>{st === "ใช้ได้" && <button type="button" className="text-xs underline text-rose-700 min-h-[44px]" onClick={() => revoke(l.id)}>ยกเลิก</button>}</li>;
          })}
        </ul>
      )}
    </div>
  );
}
