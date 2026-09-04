"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";

const ERR_TH: Record<string, string> = {
  no_open_round: "ยังไม่มีรอบจ่ายเงินเดือนที่เปิดอยู่ของผู้แนะนำ — เปิด/สร้างรอบก่อน แล้วค่อยกดจ่าย",
  not_qualified: "รายการนี้ไม่อยู่ในสถานะรอจ่ายแล้ว",
  not_found: "ไม่พบรายการ",
  pin_required: "กรุณาใส่ PIN",
  no_pin: "คุณยังไม่ได้ตั้ง PIN",
  wrong_pin: "PIN ไม่ถูกต้อง",
  forbidden: "ไม่มีสิทธิ์"
};

// Confirm-and-pay a qualified referral (owner 2026-09-04): posts the reward into
// the referrer's open payroll round. PIN-gated + logged server-side.
export default function ReferralPayButton({
  referralId, amount, referrerName
}: { referralId: number; amount: number; referrerName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function pay() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/referrals/${referralId}`), {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pay", admin_pin: pin })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(ERR_TH[j.error] ?? j.message ?? "จ่ายไม่สำเร็จ"); return; }
      setOpen(false);
      router.refresh();
    } catch { setErr("เชื่อมต่อไม่ได้"); }
    finally { setBusy(false); }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => { setOpen(true); setPin(""); setErr(null); }}
        className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 whitespace-nowrap">
        ยืนยันจ่าย {fmtMoney(amount)} บาท
      </button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="text-[11px] text-slate-500">จ่ายค่าแนะนำให้ <b>{referrerName}</b> เข้ารอบเงินเดือนที่เปิดอยู่</div>
      <div className="flex items-center gap-1.5">
        <input type="password" inputMode="numeric" autoFocus value={pin}
          onChange={(e) => setPin(e.target.value)} placeholder="PIN"
          className="border border-slate-300 rounded px-2 py-1 text-sm w-24" />
        <button type="button" disabled={busy || pin.trim() === ""} onClick={pay}
          className="text-sm px-3 py-1 rounded-lg bg-emerald-600 text-white font-medium disabled:opacity-40">
          {busy ? "..." : "จ่าย"}
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)}
          className="text-sm px-2 py-1 rounded-lg border border-slate-300 text-slate-500">ยกเลิก</button>
      </div>
      {err && <span className="text-[11px] text-rose-600 max-w-[280px] text-right">{err}</span>}
    </div>
  );
}
