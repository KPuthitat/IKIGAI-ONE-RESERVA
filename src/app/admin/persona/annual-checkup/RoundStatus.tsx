"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type R = { id: number; name: string; status: string; people: number };
const LABEL: Record<string, string> = { draft: "ร่าง (พนักงานยังไม่เห็น)", open: "เปิดอยู่ (พนักงานเห็นหมายเลขและ QR)", closed: "ปิดแล้ว" };
const CLS: Record<string, string> = { draft: "bg-amber-100 text-amber-800", open: "bg-emerald-100 text-emerald-800", closed: "bg-slate-200 text-slate-700" };

// Open / close a round. An imported round starts as a draft; employees only see their queue number and QR once it is open.
export default function RoundStatus({ rounds }: { rounds: R[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function set(roundId: number, status: "open" | "closed") {
    setBusy(roundId); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/annual-checkup/round"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roundId, status }) });
      const j = await res.json().catch(() => ({} as { message?: string }));
      if (!res.ok) throw new Error(j.message ?? "ไม่สำเร็จ");
      router.refresh();
    } catch (e) { setMsg(e instanceof Error ? e.message : "ไม่สำเร็จ"); }
    finally { setBusy(null); }
  }
  if (rounds.length === 0) return null;
  return (
    <div className="card p-4 space-y-2">
      <div className="font-semibold text-slate-800">สถานะรอบตรวจ</div>
      <ul className="divide-y divide-slate-100">
        {rounds.map((r) => (
          <li key={r.id} className="py-2 flex flex-wrap items-center gap-3">
            <div className="grow min-w-[10rem]"><div className="font-medium text-slate-800">{r.name}</div><div className="text-xs text-slate-500">{r.people} คน</div></div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${CLS[r.status] ?? ""}`}>{LABEL[r.status] ?? r.status}</span>
            {r.status !== "open" && <button type="button" disabled={busy === r.id} onClick={() => set(r.id, "open")} className="btn-primary text-sm">เปิดรอบ</button>}
            {r.status === "open" && <button type="button" disabled={busy === r.id} onClick={() => set(r.id, "closed")} className="btn-secondary text-sm">ปิดรอบ</button>}
          </li>
        ))}
      </ul>
      {msg && <p className="text-sm text-rose-600" role="alert">{msg}</p>}
    </div>
  );
}
