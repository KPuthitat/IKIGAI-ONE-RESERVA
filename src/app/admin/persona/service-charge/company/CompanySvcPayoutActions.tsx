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
// Shown in the "พิจารณาเกณฑ์แล้วหรือยัง" confirmation (owner 2026-10-07).
type Criteria = {
  people: number; full: number; half: number; none: number;
  waivedEvents: number; unreviewedLines: number; pendingLeaves: number;
};
type CriteriaReview = { reviewedAt: string; reviewedByName: string | null };

export default function CompanySvcPayoutActions({
  yearMonth, status, netPayoutPreview, totalNet, totalWht, postedAt, incomplete, payDates, hasMeetingFee,
  criteria = null, criteriaReview = null
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
  /** null = this month is not under the attendance criteria (no confirmation step). */
  criteria?: Criteria | null;
  criteriaReview?: CriteriaReview | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pinFor, setPinFor] = useState<null | Action>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Criteria confirmation (owner 2026-10-07): before a month under the attendance
  // criteria can be closed, the admin must say the eligibility criteria were considered.
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [criteriaTick, setCriteriaTick] = useState(false);
  const [criteriaConfirmed, setCriteriaConfirmed] = useState(false);
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
      // Posting confirms the transfer dates too (owner 2026-10-01: pick them
      // BEFORE the books are written), so both actions send the editor's values.
      const dates = action === "set_pay_dates" || action === "post"
        ? { svcPayDate: dSvc || null, meetingPayDate: hasMeetingFee ? (dMtg || null) : null }
        : {};
      const res = await fetch(apiUrl("/api/admin/persona/service-charge/company/payout"), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, yearMonth, pin: withPin, ...dates, ...(action === "finalize" && criteria ? { criteriaReviewed: criteriaConfirmed } : {}) })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.message || data.error || "ไม่สำเร็จ"); return; }
      setPinFor(null); setPin("");
      if (action === "finalize") { setCriteriaConfirmed(false); setCriteriaTick(false); }
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
          {criteria && status !== "draft" && criteriaReview && (
            <p className="text-[11px] text-slate-600 mt-1.5">
              ✓ พิจารณาเกณฑ์รับเซอร์วิสชาร์จ (ขาด/ลา/สาย) แล้ว
              {criteriaReview.reviewedByName ? ` โดย ${criteriaReview.reviewedByName}` : ""} · {formatBkkDateTime(criteriaReview.reviewedAt)}
            </p>
          )}
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
              onClick={() => {
                setError(null);
                if (criteria) { setCriteriaConfirmed(false); setCriteriaTick(false); setCriteriaOpen(true); } else setPinFor("finalize");
              }}
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
              <button type="button" disabled={busy}
                onClick={() => { setDSvc(payDates?.svcPayDateSet ? payDates.svcPayDate : ""); setDMtg(payDates?.meetingPayDateSet ? payDates.meetingPayDate : ""); setPinFor("post"); setError(null); }}
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

      {criteriaOpen && criteria && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setCriteriaOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto" role="dialog" aria-modal="true"
            aria-label="ยืนยันการพิจารณาเกณฑ์รับเซอร์วิสชาร์จ" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 pt-5 pb-3 border-b border-slate-100">
              <div className="text-[11px] font-semibold tracking-wide text-brand uppercase">ก่อนปิดยอด · เดือน {yearMonth}</div>
              <h3 className="text-lg font-bold text-slate-800 mt-0.5">ตรวจเกณฑ์รับเซอร์วิสชาร์จแล้วหรือยัง</h3>
              <p className="text-sm text-slate-500 mt-1">
                ดูผลของ ขาด + ลา + สาย ของพนักงานทุกคนอีกครั้งก่อนปิดยอด หากมีกรณีที่ควรยกเว้น ให้กด “ยกเว้น” ในส่วน “ตรวจเกณฑ์รับเซอร์วิสชาร์จ” ก่อน
              </p>
            </div>

            <div className="px-6 py-4 space-y-4">
              <div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2.5 text-center">
                    <div className="text-2xl font-bold text-emerald-700 tabular-nums">{criteria.full}</div>
                    <div className="text-xs text-emerald-800 mt-0.5">ได้เต็ม (คน)</div>
                  </div>
                  <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2.5 text-center">
                    <div className="text-2xl font-bold text-amber-700 tabular-nums">{criteria.half}</div>
                    <div className="text-xs text-amber-800 mt-0.5">ได้ครึ่ง (คน)</div>
                  </div>
                  <div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2.5 text-center">
                    <div className="text-2xl font-bold text-rose-700 tabular-nums">{criteria.none}</div>
                    <div className="text-xs text-rose-800 mt-0.5">ไม่ได้รับ (คน)</div>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2.5 text-center">
                    <div className="text-2xl font-bold text-slate-700 tabular-nums">{criteria.waivedEvents}</div>
                    <div className="text-xs text-slate-600 mt-0.5">ยกเว้นแล้ว (ครั้ง)</div>
                  </div>
                </div>
                <p className="text-[11px] text-slate-400 mt-2">
                  เกณฑ์: จำนวนครั้ง ขาด + ลา + สาย ÷ จำนวนวันที่ลงตารางงาน — ไม่เกิน 20% ได้เต็ม · 21–50% ได้ครึ่ง · เกิน 50% ไม่ได้รับ
                </p>
              </div>

              {criteria.pendingLeaves > 0 && (
                <div className="flex gap-2 text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded-xl px-3 py-2.5">
                  <span aria-hidden>⚠️</span>
                  <span>ยังมีใบลาที่รออนุมัติ <b>{criteria.pendingLeaves}</b> ใบในเดือนนี้ — วันดังกล่าวอาจถูกนับเป็นขาดจนกว่าจะอนุมัติหรือกดยกเว้น</span>
                </div>
              )}
              {criteria.unreviewedLines > 0 && (
                <div className="flex gap-2 text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded-xl px-3 py-2.5">
                  <span aria-hidden>⚠️</span>
                  <span>ยังไม่ได้ติ๊ก “ตรวจแล้ว” <b>{criteria.unreviewedLines}</b> คน ในตารางส่วนแบ่ง</span>
                </div>
              )}

              <label className={`flex items-start gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors ${criteriaTick ? "border-emerald-400 bg-emerald-50" : "border-slate-300 hover:bg-slate-50"}`}>
                <input type="checkbox" className="mt-1 h-4 w-4 accent-emerald-600" checked={criteriaTick} onChange={(e) => setCriteriaTick(e.target.checked)} />
                <span className="text-sm text-slate-800">ข้าพเจ้าได้พิจารณาเกณฑ์รับเซอร์วิสชาร์จ (ขาด ลา มาสาย) ของพนักงานทุกคนแล้ว</span>
              </label>
            </div>

            <div className="px-6 pb-5 flex flex-col-reverse sm:flex-row gap-2">
              <button type="button" onClick={() => setCriteriaOpen(false)}
                className="sm:flex-1 text-sm font-medium px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50">
                กลับไปตรวจก่อน
              </button>
              <button type="button" disabled={!criteriaTick}
                onClick={() => { setCriteriaConfirmed(true); setCriteriaOpen(false); setPinFor("finalize"); setError(null); }}
                className="sm:flex-1 text-sm font-bold px-4 py-2.5 rounded-xl text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed">
                ตรวจแล้ว · ไปขั้นตอนใส่ PIN
              </button>
            </div>
          </div>
        </div>
      )}

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
              {pinFor === "post" && `บันทึกยอด เดือน ${yearMonth} ลง ACCOUNTA แยกต้นทุนตามสาขา — ยืนยันวันโอนจริงด้านล่างก่อน (ว่าง = ค่าเริ่มต้น). ใส่ PIN.`}
              {pinFor === "unpost" && `ลบรายการบัญชีของเดือน ${yearMonth} ทุกสาขา แล้วกลับเป็นยังไม่ลงบัญชี. ใส่ PIN.`}
              {pinFor === "set_pay_dates" && `วันที่เงินออกจากบัญชีจริงของรอบ ${yearMonth} — เว้นว่าง = ใช้ค่าเริ่มต้น · สาขาที่ลงบัญชีไปแล้ว ระบบจะย้ายรายการใน ACCOUNTA ไปวันใหม่ให้ทันที. ใส่ PIN.`}
            </p>
            {(pinFor === "set_pay_dates" || pinFor === "post") && (
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
            <input type="password" inputMode="numeric" autoFocus={pinFor !== "set_pay_dates" && pinFor !== "post"} value={pin}
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
