"use client";

import { useState } from "react";
import BarcodeScanner from "@/app/components/BarcodeScanner";
import { apiUrl } from "@/lib/url";

type MemberSummary = {
  member_code: string; visits: number; bills: number; lastVisit: string | null; totalNett: number; pending: number;
  topItems: Array<{ name: string; qty: number }>;
};

const TH_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const thaiDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${TH_MONTHS[m]} พ.ศ. ${y + 543}`; };
const money = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ScanClient({ today }: { today: string }) {
  const [scanning, setScanning] = useState(false);
  const [q, setQ] = useState("");
  const [member, setMember] = useState<MemberSummary | null>(null);
  const [billNo, setBillNo] = useState("");
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [lastLinked, setLastLinked] = useState<string | null>(null);

  async function lookup(raw: string) {
    const v = raw.trim();
    if (!v) return;
    setBusy(true); setMsg(null); setMember(null);
    try {
      const res = await fetch(apiUrl(`/api/staff/insigna/member?q=${encodeURIComponent(v)}`), { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) { setMember(j.member); setQ(v); }
      else setMsg({ kind: "err", text: "ไม่พบสมาชิก — ตรวจสอบ QR หรือหมายเลขสมาชิกอีกครั้ง" });
    } catch { setMsg({ kind: "err", text: "เชื่อมต่อไม่สำเร็จ" }); }
    finally { setBusy(false); }
  }

  async function link() {
    if (!member || !billNo.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/staff/insigna/member"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, bill_no: billNo.trim(), sale_date: date })
      });
      const j = await res.json().catch(() => ({}));
      if (j.member) setMember(j.member);
      const r = j.result as string | undefined;
      if (r === "linked") { setMsg({ kind: "ok", text: `บันทึกบิล ${billNo.trim()} ให้สมาชิก ${member.member_code} แล้ว` }); setLastLinked(billNo.trim()); setBillNo(""); }
      else if (r === "pending") { setMsg({ kind: "ok", text: `บันทึกบิล ${billNo.trim()} แล้ว ระบบจะนับให้เมื่อนำเข้าไฟล์ใบเสร็จของวันนี้` }); setLastLinked(billNo.trim()); setBillNo(""); }
      else if (r === "already_yours") setMsg({ kind: "ok", text: "บิลนี้บันทึกให้สมาชิกท่านนี้ไว้แล้ว" });
      else if (r === "linked_to_other" || r === "pending_other") setMsg({ kind: "err", text: "บิลนี้ถูกบันทึกให้สมาชิกท่านอื่นแล้ว" });
      else setMsg({ kind: "err", text: j.error === "no_branch" ? "กรุณาเลือกสาขาก่อน" : "บันทึกไม่สำเร็จ" });
    } catch { setMsg({ kind: "err", text: "เชื่อมต่อไม่สำเร็จ" }); }
    finally { setBusy(false); }
  }

  function reset() { setMember(null); setQ(""); setBillNo(""); setMsg(null); setLastLinked(null); }

  return (
    <div className="space-y-3">
      {scanning && <BarcodeScanner title="สแกน QR บัตรสมาชิก" onResult={(text) => lookup(text)} onClose={() => setScanning(false)} />}
      {msg && <div className={`rounded-lg px-3 py-2 text-sm ${msg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</div>}

      {!member ? (
        <div className="card space-y-3">
          <button type="button" onClick={() => setScanning(true)} disabled={busy}
            className="w-full py-4 rounded-xl bg-emerald-600 text-white font-bold text-base disabled:opacity-50">
            📷 สแกน QR บัตรสมาชิก
          </button>
          <div className="text-center text-xs text-slate-400">หรือ</div>
          <div className="flex gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value.replace(/\D/g, "").slice(0, 8))} inputMode="numeric" placeholder="หมายเลขสมาชิก 8 หลัก เช่น 69100001"
              className="input flex-1 font-mono text-lg tracking-widest" onKeyDown={(e) => { if (e.key === "Enter") lookup(q); }} />
            <button type="button" onClick={() => lookup(q)} disabled={busy || q.length !== 8} className="btn btn-secondary disabled:opacity-50">ค้นหา</button>
          </div>
        </div>
      ) : (
        <div className="card space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[11px] text-slate-500">สมาชิกหมายเลข</div>
              <div className="text-3xl font-black tracking-[0.15em] text-emerald-800 tabular-nums">{member.member_code}</div>
            </div>
            <button type="button" onClick={reset} className="text-xs text-slate-500 hover:text-slate-800">สแกนคนถัดไป</button>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-slate-50 p-2">
              <div className="text-lg font-bold text-slate-800 tabular-nums">{member.visits}</div>
              <div className="text-[10px] text-slate-500">ครั้งที่มา</div>
            </div>
            <div className="rounded-xl bg-slate-50 p-2">
              <div className="text-lg font-bold text-slate-800 tabular-nums">{member.totalNett > 0 ? money(member.totalNett) : "—"}</div>
              <div className="text-[10px] text-slate-500">ยอดสะสม</div>
            </div>
            <div className="rounded-xl bg-slate-50 p-2">
              <div className="text-sm font-bold text-slate-800 leading-tight">{member.lastVisit ? thaiDate(member.lastVisit) : "ครั้งแรก"}</div>
              <div className="text-[10px] text-slate-500">มาล่าสุด</div>
            </div>
          </div>
          {member.topItems.length > 0 && <div className="text-[11px] text-slate-500">เมนูที่สั่งบ่อย: {member.topItems.map((i) => i.name).join(", ")}</div>}
          {member.pending > 0 && <div className="text-[11px] text-amber-700">มีบิลที่รอนำเข้าใบเสร็จ {member.pending} ใบ</div>}

          <div className="border-t border-slate-100 pt-3 space-y-2">
            <label className="label">เลขที่บิลจาก POS (ช่อง No.)</label>
            <div className="flex gap-2">
              <input value={billNo} onChange={(e) => setBillNo(e.target.value)} placeholder="เช่น 1428" inputMode="numeric" autoFocus
                className="input flex-1 text-lg" onKeyDown={(e) => { if (e.key === "Enter") link(); }} />
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input w-40" />
            </div>
            <button type="button" onClick={link} disabled={busy || !billNo.trim()} className="w-full py-3 rounded-xl bg-emerald-600 text-white font-bold disabled:opacity-50">
              {busy ? "กำลังบันทึก…" : "บันทึกบิลให้สมาชิก"}
            </button>
            {lastLinked && <div className="text-[11px] text-slate-400 text-center">บิลล่าสุดที่บันทึก: {lastLinked}</div>}
          </div>
        </div>
      )}
      <p className="text-[11px] text-slate-400">ระบบแสดงเฉพาะหมายเลขสมาชิก ไม่มีชื่อลูกค้า · บิลจะนับเป็นการมาใช้บริการเมื่อไฟล์ใบเสร็จของวันนั้นถูกนำเข้าใน ANALYTICA</p>
    </div>
  );
}
