"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Banner, post } from "./shared";

const when = (iso: string) => new Date(iso.replace(" ", "T") + "Z").toLocaleString("th-TH", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) + " น.";

/** "Send to the doctor": shown to the recorder once every required test has a result; the doctor is told on LINE (a count, no names). */
export default function SubmitPanel({ roundId, subject, allRecorded, submission, released }: { roundId: number; subject: string; allRecorded: boolean; submission: { submitted_at: string; by_name: string } | null; released: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (released) return null;
  const send = async () => {
    setBusy(true); setMsg(null);
    const r = await post("submit", { roundId, subject });
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: `ส่งให้แพทย์แล้ว${Number(r.notifiedDoctors) > 0 ? " และแจ้งแพทย์ใน LINE แล้ว" : ""}` } : { ok: false, text: r.message ?? "ส่งไม่สำเร็จ" });
    if (r.ok) router.refresh();
  };
  return (
    <div className="card p-3 flex flex-wrap items-center gap-3">
      <div className="grow text-sm">
        {submission ? <span className="text-sky-800">ส่งให้แพทย์แล้ว {when(submission.submitted_at)} โดย {submission.by_name}</span>
          : allRecorded ? <span className="text-slate-700">ลงผลครบทุกรายการแล้ว ส่งให้แพทย์ตรวจสอบได้</span>
          : <span className="text-slate-500">ลงผลให้ครบทุกรายการที่ไม่งดก่อน จึงจะส่งให้แพทย์ได้</span>}
      </div>
      <button type="button" className="btn-primary text-sm" disabled={busy || !allRecorded} onClick={send}>{submission ? "ส่งให้แพทย์อีกครั้ง" : "ส่งให้แพทย์"}</button>
      <div className="w-full"><Banner msg={msg} /></div>
    </div>
  );
}
