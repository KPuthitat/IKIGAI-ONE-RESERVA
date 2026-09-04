import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fmtMoney } from "@/lib/format";
import { nameWithPrefix } from "@/lib/name";
import {
  evaluateDueReferrals, evaluateReferral, listReferrals,
  REFERRAL_RETENTION_DAYS, REFERRAL_MAX_LATE_ABSENCE_RATIO, REFERRAL_MIN_ATTENDANCE_RATIO,
  type ReferralListRow
} from "@/lib/referral";
import ReferralPayButton from "./ReferralsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ค่าแนะนำพนักงาน · PERSONA" };

const REASON_TH: Record<string, string> = {
  retention: "ลาออก/พ้นสภาพก่อนครบกำหนด",
  late_absence: "ขาด/ลา/สาย เกิน 20%",
  attendance: "ส่งเวรน้อยกว่า 50%"
};

export default function ReferralsPage() {
  requirePayrollAccess();
  const db = getDb();
  // Auto-advance any referral that has reached 119 days (qualified/disqualified).
  evaluateDueReferrals(db);
  const rows = listReferrals(db);

  const byStatus = (s: string) => rows.filter((r) => r.status === s);
  const qualified = byStatus("qualified");
  const pending = byStatus("pending");
  const paid = byStatus("paid");
  const disq = byStatus("disqualified");

  // Live gate numbers for qualified + pending rows (advisory display).
  const evalOf = new Map<number, ReturnType<typeof evaluateReferral>>();
  for (const r of [...qualified, ...pending]) {
    evalOf.set(r.id, evaluateReferral(db, { referred_user_id: r.referred_user_id, hire_date: r.hire_date, eligible_on: r.eligible_on }));
  }

  const nm = (row: ReferralListRow, which: "referrer" | "referred") =>
    which === "referrer" ? (row.referrer_name ?? `#${row.referrer_user_id}`) : (row.referred_name ?? `#${row.referred_user_id}`);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ค่าแนะนำพนักงาน</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          พนักงานที่แนะนำคนมาทำงาน ได้ค่าแนะนำ {fmtMoney(500)} บาท เมื่อผู้ถูกแนะนำอยู่ครบ {REFERRAL_RETENTION_DAYS} วัน
          และผ่านเกณฑ์ (ขาด/ลา/สาย ≤ {REFERRAL_MAX_LATE_ABSENCE_RATIO * 100}% · ส่งเวร ≥ {REFERRAL_MIN_ATTENDANCE_RATIO * 100}%)
        </p>
      </div>

      {/* Qualified — ready to pay */}
      <section className="space-y-2">
        <h2 className="font-semibold text-emerald-700">ผ่านเกณฑ์ — รอจ่าย ({qualified.length})</h2>
        {qualified.length === 0 ? (
          <p className="text-sm text-slate-400">— ยังไม่มีรายการรอจ่าย —</p>
        ) : (
          <div className="grid gap-2">
            {qualified.map((r) => {
              const ev = evalOf.get(r.id);
              return (
                <div key={r.id} className="card flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm">
                    <div className="font-medium text-slate-800">
                      ผู้แนะนำ: {nm(r, "referrer")}
                      <span className="text-slate-400"> · แนะนำ {nm(r, "referred")}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      เข้างาน {r.hire_date ?? "—"} · ครบกำหนด {r.eligible_on ?? "—"}
                      {ev && ` · ขาด/ลา/สาย ${ev.penaltyPct}% · ส่งเวร ${ev.attendancePct}% (${ev.daysWorked}/${ev.scheduledDays} วัน)`}
                      {ev && !ev.computable && " · ไม่มีตารางกะให้เทียบ (โปรดตรวจเอง)"}
                    </div>
                  </div>
                  <ReferralPayButton referralId={r.id} amount={r.reward_amount} referrerName={nm(r, "referrer")} />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Pending — not yet 119 days */}
      <section className="space-y-2">
        <h2 className="font-semibold text-slate-700">กำลังนับอายุงาน ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="text-sm text-slate-400">— ไม่มี —</p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">ผู้แนะนำ</th><th className="py-2 pr-3">ผู้ถูกแนะนำ</th>
                <th className="py-2 pr-3">เข้างาน</th><th className="py-2 pr-3">ครบกำหนด</th>
                <th className="py-2 pr-3">แนวโน้ม</th>
              </tr></thead>
              <tbody>
                {pending.map((r) => {
                  const ev = evalOf.get(r.id);
                  return (
                    <tr key={r.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-3 font-medium text-slate-800">{nm(r, "referrer")}</td>
                      <td className="py-2 pr-3 text-slate-600">{nm(r, "referred")}</td>
                      <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{r.hire_date ?? "—"}</td>
                      <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{r.eligible_on ?? "—"}</td>
                      <td className="py-2 pr-3 text-xs">
                        {ev
                          ? <span className={ev.qualified ? "text-emerald-600" : "text-amber-600"}>
                              {ev.qualified ? "ตอนนี้ผ่านเกณฑ์" : "ยังไม่ผ่าน"} · ส่งเวร {ev.attendancePct}%
                            </span>
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Paid + disqualified — history */}
      {(paid.length > 0 || disq.length > 0) && (
        <section className="space-y-2">
          <h2 className="font-semibold text-slate-500">ประวัติ</h2>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">ผู้แนะนำ</th><th className="py-2 pr-3">ผู้ถูกแนะนำ</th>
                <th className="py-2 pr-3">สถานะ</th><th className="py-2 pr-3">รายละเอียด</th>
              </tr></thead>
              <tbody>
                {[...paid, ...disq].map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-3 font-medium text-slate-800">{nm(r, "referrer")}</td>
                    <td className="py-2 pr-3 text-slate-600">{nm(r, "referred")}</td>
                    <td className="py-2 pr-3">
                      {r.status === "paid"
                        ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold">จ่ายแล้ว</span>
                        : <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-bold">ไม่ผ่านเกณฑ์</span>}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-500">
                      {r.status === "paid"
                        ? `จ่าย ${fmtMoney(r.reward_amount)} บาท เข้ารอบเงินเดือน`
                        : (r.disqualify_reason ?? "").split(",").filter(Boolean).map((x) => REASON_TH[x] ?? x).join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
