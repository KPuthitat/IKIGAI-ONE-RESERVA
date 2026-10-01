"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { formatBkkDateTime } from "@/lib/time";

// Company-wide เซอร์วิสชาร์จ payout (owner 2026-09-03) — mirrors the per-branch
// widget but drives every branch at once through /company/payout. Finalize is
// blocked until every branch's month is complete. Same 3 steps + PIN gates.
type Status = "draft" | "finalized" | "paid" | "posted";
type Action = "finalize" | "unfinalize" | "mark_paid" | "unpay" | "post" | "unpost" | "set_pay_dates";
type PayDates = { svcPayDate: string; meetingPayDate: string; svcPayDateSet: boolean; meetingPayDateSet: boolean };

export default function CompanySvcPayoutActions({
  yearMonth, status, netPayoutPreview, totalNet, totalWht, postedAt, incomplete, payDates, hasMeetingFee
}: {
  yearMonth: string;
  status: Status;
  netPayoutPreview: number;
  totalNet: number;
  totalWht: number;
  postedAt: string | null;
  incomplete: Array<{ id: number; name: string; filled: number; days: number }>;
  payDates: PayDates | null;      // actual transfer dates (owner 2026-10-01); null until finalized
  hasMeetingFee: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pinFor, setPinFor] = useState<null | Action>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Transfer-date editor (set_pay_dates). Pre-filled ONLY with dates the owner set
  // explicitly; an empty field means "default" (SVC: the 20th · meeting fee: same
  // day as SVC) and is sent as null, so confirming never pins a default as if it
  // had been chosen. The meeting field is hidden (and sent as null) when the
  // month has no meeting fee.
  const [dSvc, setDSvc] = useState(payDates?.svcPayDateSet ? payDates.svcPayDate : "");
  const [dMtg, setDMtg] = useState(payDates?.meetingPayDateSet ? payDates.meetingPayDate : "");

  const blockedByIncomplete = status === "draft" && incomplete.length > 0;

  async function call(action: Action, withPin?: string) {
    setBusy(true); setError(null);
    try {
      const dates = action === "set_pay_dates"
        ? { svcPayDate: dSvc || null, meetingPayDate: hasMeetingFee ? (dMtg || null) : null }
        : {};
      const res = await fetch(apiUrl("/api/admin/persona/service-charge/company/payout"), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, yearMonth, pin: withPin, ...dates })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.message || data.error || "ไม่สำเร็จ"); return; }
      setPinFor(null); setPin("");
      router.refresh();
    } catch {
      setError("เชื่อมต่อไม่ได้");
    } finally {
      setBusy(false);
    }
  }

  const btnBase = "text-sm px-3 py-1.5 rounded-md disabled:opacity-50";
  const secondary = `${btnBase} bg-white border border-slate-300 text-slate-700 hover:bg-slate-50`;

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">การทำจ่ายเซอร์วิสชาร์จ · รวมทั้งบริษัท</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {status === "draft" && `ยังไม่ปิดยอด · ยอดจ่ายจริงโดยประมาณ ฿${fmtMoney(netPayoutPreview)}`}
            {status === "finalized" && `ปิดยอดแล้ว · รอทำจ่าย · ยอดจ่ายจริงโดยประมาณ ฿${fmtMoney(netPayoutPreview)}`}
            {status === "paid" && `ทำจ่ายแล้ว · รอลงบัญชี · ยอดจ่ายจริงโดยประมาณ ฿${fmtMoney(netPayoutPreview)}`}
            {status === "posted" && (
              <span className="text-emerald-700">
                ✓ ลงบัญชี ACCOUNTA แล้ว (แยกต้นทุนตามสาขา){postedAt ? ` · ${formatBkkDateTime(postedAt)}` : ""}
                {" · "}ยอดจ่ายจริง ฿{fmtMoney(totalNet)}
                {totalWht > 0 ? ` · หัก ณ ที่จ่าย ฿${fmtMoney(totalWht)}` : ""}
              </span>
            )}
          </p>
          <div className="flex items-center gap-1 mt-1.5 text-[11px]">
            {(["ปิดยอด", "ทำจ่าย", "ลงบัญชี"] as const).map((label, i) => {
              const reached = (status === "finalized" && i === 0)
                || (status === "paid" && i <= 1)
                || (status === "posted" && i <= 2);
              return (
                <span key={label} className="flex items-center gap-1">
                  <span className={`px-2 py-0.5 rounded-full ${reached ? "bg-emerald-100 text-emerald-700 font-semibold" : "bg-slate-100 text-slate-400"}`}>
                    {i + 1}. {label}
                  </span>
                  {i < 2 && <span className="text-slate-300">→</span>}
                </span>
              );
            })}
          </div>
          {blockedByIncomplete && (
            <p className="text-[11px] text-amber-700 mt-1.5">
              ยังลงเซอร์วิสชาร์จไม่ครบทั้งเดือน: {incomplete.map((b) => `${b.name} (${b.filled}/${b.days} วัน)`).join(", ")} — ต้องครบทุกสาขาก่อนปิดยอด
            </p>
          )}
          {/* Actual transfer dates — what ACCOUNTA books on (owner 2026-10-01).
              Default: SVC on the 20th, meeting fee same day; editable with PIN. */}
          {payDates && status !== "draft" && (
            <p className="text-[11px] text-slate-600 mt-1.5 flex items-center gap-2 flex-wrap">
              <span>วันโอนเซอร์วิสชาร์จ <b className="text-slate-800">{payDates.svcPayDate}</b>{!payDates.svcPayDateSet && <span className="text-slate-400"> (ค่าเริ่มต้น วันที่ 20)</span>}</span>
              {hasMeetingFee && (
                <span>· วันโอนเบี้ยประชุม <b className="text-slate-800">{payDates.meetingPayDate}</b>{!payDates.meetingPayDateSet && <span className="text-slate-400"> (ตามวันเซอร์วิสชาร์จ)</span>}</span>
              )}
              <button type="button" disabled={busy}
                onClick={() => { setDSvc(payDates.svcPayDateSet ? payDates.svcPayDate : ""); setDMtg(payDates.meetingPayDateSet ? payDates.meetingPayDate : ""); setPinFor("set_pay_dates"); setError(null); }}
                className="text-[11px] px-2 py-0.5 rounded border border-slate-300 text-brand hover:bg-slate-50 disabled:opacity-50">
                แก้ไขวันโอน
              </button>
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {status === "draft" && (
            <button type="button" disabled={busy || blockedByIncomplete}
              title={blockedByIncomplete ? "ลงข้อมูลให้ครบทุกสาขาก่อน" : undefined}
              onClick={() => { setPinFor("finalize"); setError(null); }}
              className={`${btnBase} bg-slate-800 hover:bg-slate-900 text-white font-medium`}>
              1. ปิดยอด (finalize)
            </button>
          )}
          {status === "finalized" && (
            <>
              <button type="button" disabled={busy} onClick={() => call("unfinalize")} className={secondary}>
                ↺ ยกเลิกปิดยอด
              </button>
              <button type="button" disabled={busy} onClick={() => call("mark_paid")}
                className={`${btnBase} bg-sky-600 hover:bg-sky-700 text-white font-medium`}>
                2. ทำจ่าย
              </button>
            </>
          )}
          {status === "paid" && (
            <>
              <button type="button" disabled={busy} onClick={() => call("unpay")}
                className={`${btnBase} text-rose-700 hover:bg-rose-50`}>
                ↺ ยกเลิกทำจ่าย
              </button>
              <button type="button" disabled={busy} onClick={() => { setPinFor("post"); setError(null); }}
                className={`${btnBase} bg-emerald-600 hover:bg-emerald-700 text-white font-medium`}>
                3. ลงบัญชี ACCOUNTA
              </button>
            </>
          )}
          {status === "posted" && (
            <>
              <span className="text-sm text-emerald-700 font-medium px-3 py-1.5 rounded-md bg-emerald-50 border border-emerald-200">
                ✓ ลงบัญชีแล้ว
              </span>
              <button type="button" disabled={busy} onClick={() => { setPinFor("unpost"); setError(null); }}
                className={`${btnBase} text-rose-700 hover:bg-rose-50`}>
                ยกเลิกลงบัญชี
              </button>
            </>
          )}
        </div>
      </div>

      {pinFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && setPinFor(null)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-xs w-full p-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-slate-800 text-sm mb-1">
              {pinFor === "finalize" && "ยืนยันปิดยอด (ทั้งบริษัท)"}
              {pinFor === "post" && "ยืนยันลงบัญชี ACCOUNTA (ทั้งบริษัท)"}
              {pinFor === "unpost" && "ยกเลิกลงบัญชี (ลบรายการบัญชีทุกสาขา)"}
              {pinFor === "set_pay_dates" && "แก้ไขวันโอนจริง (ใช้ลงบัญชี ACCOUNTA)"}
            </h3>
            <p className="text-[11px] text-slate-500 mb-2">
              {pinFor === "finalize" && `ล็อกยอด เซอร์วิสชาร์จ เดือน ${yearMonth} ทุกสาขา. ใส่ PIN เพื่อยืนยัน.`}
              {pinFor === "post" && `บันทึกยอด เดือน ${yearMonth} ลง ACCOUNTA แยกต้นทุนตามสาขา. ใส่ PIN.`}
              {pinFor === "unpost" && `ลบรายการบัญชีของเดือน ${yearMonth} ทุกสาขา แล้วกลับเป็นยังไม่ลงบัญชี. ใส่ PIN.`}
              {pinFor === "set_pay_dates" && `วันที่เงินออกจากบัญชีจริงของรอบ ${yearMonth} — เว้นว่าง = ใช้ค่าเริ่มต้น · สาขาที่ลงบัญชีไปแล้ว ระบบจะย้ายรายการใน ACCOUNTA ไปวันใหม่ให้ทันที. ใส่ PIN.`}
            </p>
            {pinFor === "set_pay_dates" && (
              <div className="space-y-2 mb-2">
                <label className="block text-[11px] text-slate-600">
                  วันโอนเซอร์วิสชาร์จ <span className="text-slate-400">(ว่าง = วันที่ 20 → {payDates?.svcPayDateSet ? "" : payDates?.svcPayDate ?? ""})</span>
                  <input type="date" value={dSvc} onChange={(e) => setDSvc(e.target.value)} className="input w-full mt-0.5" />
                </label>
                {hasMeetingFee && (
                  <label className="block text-[11px] text-slate-600">
                    วันโอนเบี้ยประชุม <span className="text-slate-400">(ว่าง = วันเดียวกับเซอร์วิสชาร์จ)</span>
                    <input type="date" value={dMtg} onChange={(e) => setDMtg(e.target.value)} className="input w-full mt-0.5" />
                  </label>
                )}
              </div>
            )}
            <input type="password" inputMode="numeric" autoFocus={pinFor !== "set_pay_dates"} value={pin}
              onChange={(e) => setPin(e.target.value)} placeholder="PIN"
              onKeyDown={(e) => { if (e.key === "Enter" && !busy && pin.trim() && pinFor) { e.preventDefault(); void call(pinFor, pin); } }}
              className="input w-full text-center tracking-widest mb-2" />
            {error && <p className="text-xs text-rose-600 mb-2">{error}</p>}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => setPinFor(null)}
                className="flex-1 text-xs px-3 py-2 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                ยกเลิก
              </button>
              <button type="button" disabled={busy || !pin.trim()} onClick={() => call(pinFor, pin)}
                className={`flex-1 text-xs font-bold px-3 py-2 rounded text-white disabled:opacity-50 ${
                  pinFor === "unpost" ? "bg-rose-600 hover:bg-rose-700" : "bg-emerald-600 hover:bg-emerald-700"
                }`}>
                {busy ? "..." : "ยืนยัน"}
              </button>
            </div>
          </div>
        </div>
      )}
      {error && !pinFor && <p className="text-xs text-rose-600 mt-2">{error}</p>}
    </div>
  );
}
