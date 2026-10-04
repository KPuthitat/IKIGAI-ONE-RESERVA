"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";
import { thaiDate } from "@/lib/revshare";

type Status = { enabled: boolean; postedDays: number; firstDate: string | null; lastDate: string | null; openReceivable: number; openReceivableCount: number };
type Posted = { days: number; cashRows: number; receivableOpenRows: number; receivableSettledRows: number; unknownChannelAmount: number; supersededShiftCloseDays: number };

const baht = (n: number) => `${Math.round(n).toLocaleString("th-TH")} บาท`;

// Switch that makes ACCOUNTA's income for this clinic come from the imported HIS
// files (sales by invoice, channel from receipts, receivables per bill) instead of
// the shift-close report (owner 2026-10-04).
export default function ClinicaAccountaCard({ stamp }: { stamp: string }) {
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function load() {
    try {
      const res = await fetch(apiUrl("/api/admin/reporta/clinica-accounta"), { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) setSt(j.status as Status);
    } catch { /* card stays hidden */ }
  }
  // `stamp` changes when the month data is re-fetched (after an import), so the
  // posted-days figure follows the auto re-post.
  useEffect(() => { void load(); }, [stamp]);

  async function act(action: "enable" | "repost" | "disable") {
    if (busy) return;
    if (action === "enable" && !window.confirm(
      "เปิดส่งยอดเข้า ACCOUNTA อัตโนมัติ?\n\nรายรับของสาขานี้ในวันที่มีไฟล์ Invoice จะถูกแทนที่ด้วยยอดจากไฟล์ (แทนยอดที่มาจากรายงานปิดกะของวันนั้น) และแก้ที่ ACCOUNTA ตรงๆ ไม่ได้ ต้องแก้ที่ต้นทางแล้วนำเข้าใหม่"
    )) return;
    if (action === "disable" && !window.confirm("ปิดส่งยอดอัตโนมัติ? ยอดที่ส่งไปแล้วยังอยู่ แต่วันใหม่จะกลับไปใช้ยอดจากรายงานปิดกะ")) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/reporta/clinica-accounta"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action })
      });
      const j = await res.json().catch(() => ({})) as { ok?: boolean; message?: string; status?: Status; posted?: Posted };
      if (!res.ok || !j.ok) { setMsg({ kind: "err", text: j.message ?? "ทำรายการไม่สำเร็จ (ต้องมีสิทธิ์ ACCOUNTA ด้วย)" }); return; }
      if (j.status) setSt(j.status);
      if (j.posted) {
        const p = j.posted;
        setMsg({ kind: "ok", text: `ส่งแล้ว ${p.days} วัน · รับเงินตามช่องทาง ${p.cashRows} รายการ · ค้างรับ ${p.receivableOpenRows} บิล${p.unknownChannelAmount > 0 ? ` · ไม่ทราบช่องทาง ${baht(p.unknownChannelAmount)} (นำเข้าไฟล์ใบเสร็จเพิ่ม)` : ""}${p.supersededShiftCloseDays > 0 ? ` · แทนยอดปิดกะ ${p.supersededShiftCloseDays} วัน` : ""}` });
      }
    } catch { setMsg({ kind: "err", text: "เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง" }); }
    finally { setBusy(false); }
  }

  if (!st) return null;
  return (
    <div className="card space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="font-bold text-slate-800 text-sm">ส่งยอดเข้า ACCOUNTA จากไฟล์คลินิก</h3>
        <span className={`text-[11px] px-2 py-0.5 rounded-full border ${st.enabled ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-50 text-slate-500 border-slate-200"}`}>{st.enabled ? "เปิดอยู่" : "ปิดอยู่"}</span>
      </div>
      {st.enabled ? (
        <p className="text-[11px] text-slate-500">
          ทุกครั้งที่นำเข้าไฟล์ ระบบสร้างรายรับใน ACCOUNTA ให้อัตโนมัติ — ยอดขายตามใบแจ้งหนี้ · แยกช่องทางตามใบเสร็จ · ส่วนที่ประกัน/บริษัทค้างจ่ายเป็นลูกหนี้รายบิล (เงินเข้าเมื่อยืนยันวันที่ในการ์ด "ได้รับชำระแล้ว")
          {st.postedDays > 0 && st.firstDate && st.lastDate && <> · ส่งแล้ว {st.postedDays.toLocaleString("th-TH")} วัน ({thaiDate(st.firstDate)} – {thaiDate(st.lastDate)})</>}
          {st.openReceivableCount > 0 && <> · ลูกหนี้คงค้าง {baht(st.openReceivable)} ({st.openReceivableCount.toLocaleString("th-TH")} บิล)</>}
        </p>
      ) : (
        <p className="text-[11px] text-slate-500">ตอนนี้รายรับของคลินิกใน ACCOUNTA มาจากรายงานปิดกะ เปิดสวิตช์นี้เพื่อให้มาจากไฟล์ Invoice + ใบเสร็จแทน ลดงานคีย์ของน้องๆ</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {st.enabled ? (
          <>
            <button type="button" disabled={busy} onClick={() => act("repost")} className="btn-primary text-xs disabled:opacity-50">{busy ? "กำลังส่ง…" : "ส่งใหม่ทั้งหมด"}</button>
            <button type="button" disabled={busy} onClick={() => act("disable")} className="text-xs text-slate-400 hover:text-slate-600">ปิดส่งอัตโนมัติ</button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => act("enable")} className="btn-primary text-xs disabled:opacity-50">{busy ? "กำลังส่ง…" : "เปิดและส่งยอดย้อนหลังทั้งหมด"}</button>
        )}
      </div>
      {msg && <p className={`text-xs ${msg.kind === "ok" ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</p>}
    </div>
  );
}
