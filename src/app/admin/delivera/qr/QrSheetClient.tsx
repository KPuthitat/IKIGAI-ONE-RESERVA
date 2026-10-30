"use client";

import { useEffect, useMemo, useState } from "react";
import QrCode from "@/app/components/QrCode";
import { apiUrl } from "@/lib/url";

// Printable QR cards: one counter (pick-up) card + one per table label.
export default function QrSheetClient({ slug, branchName }: { slug: string; branchName: string }) {
  const [origin, setOrigin] = useState("");
  const [tables, setTables] = useState("1-8");
  useEffect(() => { setOrigin(window.location.origin); }, []);

  const labels = useMemo(() => parseTables(tables), [tables]);
  const base = `${origin}${apiUrl(`/o/${slug}`)}`;
  const cards = [{ key: "counter", title: "สั่งรับที่เคาน์เตอร์", url: base }, ...labels.map((t) => ({ key: `t-${t}`, title: `โต๊ะ ${t}`, url: `${base}?t=${encodeURIComponent(t)}` }))];

  return (
    <div className="space-y-4">
      <div className="card print:hidden">
        <label className="block text-sm font-medium text-slate-700">โต๊ะที่ต้องการสร้าง QR</label>
        <input value={tables} onChange={(e) => setTables(e.target.value)} placeholder="เช่น 1-8 หรือ A1,A2,B1"
          className="mt-1 w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <p className="text-[11px] text-slate-400 mt-1">ใส่เป็นช่วง (1-8) หรือคั่นด้วยจุลภาค (A1,A2,ริมระเบียง) · สูงสุด 60 โต๊ะ</p>
        <button type="button" onClick={() => window.print()} className="mt-3 rounded-lg bg-brand text-white px-4 py-2 text-sm font-medium">พิมพ์ QR</button>
      </div>
      {origin && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 print:gap-2">
          {cards.map((c) => (
            <div key={c.key} className="rounded-xl border border-slate-200 bg-white p-3 text-center break-inside-avoid">
              <div className="text-xs text-slate-500">{branchName}</div>
              <div className="text-lg font-bold text-slate-800 mb-1">{c.title}</div>
              <QrCode value={c.url} size={160} />
              <div className="text-[11px] text-slate-500 mt-1">สแกนเพื่อสั่งอาหาร</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function parseTables(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,3})\s*-\s*(\d{1,3})$/.exec(part);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b) && out.length < 60; i++) out.push(String(i));
    } else out.push(part.slice(0, 20));
    if (out.length >= 60) break;
  }
  return Array.from(new Set(out)).slice(0, 60);
}
