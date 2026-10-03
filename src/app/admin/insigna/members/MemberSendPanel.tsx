"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";

// Sends from the members page (owner 2026-10-03): the member report to the
// HOD LINE group, the birthday greeting, the win-back note. Each confirms with
// the admin PIN. The two member messages are editable here (blank = default).

type Kind = "report" | "birthday" | "winback";

export default function MemberSendPanel({ year, branchId, hasGroup, activeBranchName, birthdayTargets, winbackTargets, birthdayText, winbackText, birthdayCustom, winbackCustom }: {
  year: number; branchId: number | null; hasGroup: boolean; activeBranchName: string | null;
  birthdayTargets: number; winbackTargets: number;
  birthdayText: string; winbackText: string; birthdayCustom: boolean; winbackCustom: boolean;
}) {
  const [bText, setBText] = useState(birthdayCustom ? birthdayText : "");
  const [wText, setWText] = useState(winbackCustom ? winbackText : "");
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<Kind | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  async function saveTexts() {
    setSaving(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/insigna/members/settings"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ birthday_text: bText.trim() || null, winback_text: wText.trim() || null })
      });
      const j = await res.json().catch(() => ({}));
      setMsg(res.ok && j.ok ? { kind: "ok", text: "บันทึกข้อความแล้ว" } : { kind: "err", text: "บันทึกไม่สำเร็จ" });
    } catch { setMsg({ kind: "err", text: "เชื่อมต่อไม่สำเร็จ" }); }
    finally { setSaving(false); }
  }

  async function send() {
    if (!pending || !/^\d{4}$/.test(pin)) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/insigna/members/notify"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: pending, year, branch: branchId, pin })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        const e = j.error as string | undefined;
        setMsg({ kind: "err", text: e === "wrong_pin" || e === "pin_invalid" ? "PIN ไม่ถูกต้อง" : e === "no_pin" ? "ยังไม่ได้ตั้ง PIN (ตั้งที่หน้าโปรไฟล์)" : (j.message ?? "ส่งไม่สำเร็จ") });
      } else if (pending === "report") {
        setMsg({ kind: "ok", text: "ส่งรายงานสมาชิกเข้ากลุ่ม LINE หัวหน้างานแล้ว" });
      } else {
        setMsg({ kind: "ok", text: `ส่งแล้ว ${j.sent} ราย${j.skipped ? ` · ข้าม ${j.skipped} ราย (ไม่มีช่องทาง LINE หรือส่งไม่สำเร็จ)` : ""}` });
      }
      setPending(null); setPin("");
    } catch { setMsg({ kind: "err", text: "เชื่อมต่อไม่สำเร็จ" }); }
    finally { setBusy(false); }
  }

  const title = (k: Kind) => k === "report" ? `ส่งรายงานสมาชิกเข้ากลุ่ม LINE หัวหน้างาน${activeBranchName ? ` (${activeBranchName})` : ""}` : k === "birthday" ? `ส่งคำอวยพรวันเกิด ${birthdayTargets} ราย` : `ส่งข้อความชวนกลับมา ${winbackTargets} ราย`;

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="font-bold text-slate-800 text-sm">ส่งรายงานและข้อความ</h2>
        <button type="button" onClick={() => setEditOpen((v) => !v)} className="text-xs text-brand">{editOpen ? "ซ่อนข้อความ" : "แก้ไขข้อความที่ส่งถึงสมาชิก"}</button>
      </div>
      {msg && <div className={`rounded-lg px-3 py-2 text-sm ${msg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</div>}
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" disabled={!hasGroup} title={hasGroup ? "" : "ตั้งกลุ่ม LINE หัวหน้างานของสาขาที่เลือกอยู่ที่หน้าตั้งค่า ANALYTICA ก่อน"} onClick={() => { setPending("report"); setMsg(null); }}
          className="btn-primary text-sm disabled:opacity-50">ส่งรายงานสมาชิก (รายงานผู้บริหาร)</button>
        <button type="button" disabled={birthdayTargets === 0} onClick={() => { setPending("birthday"); setMsg(null); }}
          className="btn-secondary text-sm disabled:opacity-50">ส่งคำอวยพรวันเกิด ({birthdayTargets})</button>
        <button type="button" disabled={winbackTargets === 0} onClick={() => { setPending("winback"); setMsg(null); }}
          className="btn-secondary text-sm disabled:opacity-50">ส่งข้อความชวนกลับมา ({winbackTargets})</button>
      </div>
      <p className="text-[11px] text-slate-400">ข้อความถึงสมาชิกส่งเฉพาะผู้ที่ยินยอมรับข่าวสาร ผ่าน LINE OA ของสาขาที่สมัคร · คำอวยพรวันเกิดส่งปีละครั้ง · ข้อความชวนกลับมาส่งไม่ถี่กว่า 30 วันต่อคน</p>

      {editOpen && (
        <div className="space-y-3 pt-2 border-t border-slate-100">
          <div>
            <label className="label">ข้อความอวยพรวันเกิด</label>
            <textarea value={bText} onChange={(e) => setBText(e.target.value.slice(0, 500))} rows={3} className="input" placeholder={birthdayText} />
            <p className="text-[11px] text-slate-400 mt-1">เว้นว่าง = ใช้ข้อความมาตรฐานด้านบน</p>
          </div>
          <div>
            <label className="label">ข้อความชวนกลับมา</label>
            <textarea value={wText} onChange={(e) => setWText(e.target.value.slice(0, 500))} rows={3} className="input" placeholder={winbackText} />
          </div>
          <button type="button" onClick={saveTexts} disabled={saving} className="btn-primary text-sm disabled:opacity-50">{saving ? "กำลังบันทึก…" : "บันทึกข้อความ"}</button>
        </div>
      )}

      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) { setPending(null); setPin(""); } }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-3">
            <h3 className="font-bold text-slate-800">{title(pending)}</h3>
            <p className="text-sm text-slate-500">ยืนยันด้วย PIN เพื่อส่ง</p>
            <input type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={4} value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }}
              className="input text-center tracking-[0.6em] text-lg" placeholder="PIN 4 หลัก" />
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => { setPending(null); setPin(""); }} className="flex-1 py-2.5 rounded-lg border border-slate-200 text-sm font-semibold text-slate-600">ยกเลิก</button>
              <button type="button" onClick={send} disabled={busy || pin.length < 4} className="flex-1 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-bold disabled:opacity-50">{busy ? "กำลังส่ง…" : "ยืนยันส่ง"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
