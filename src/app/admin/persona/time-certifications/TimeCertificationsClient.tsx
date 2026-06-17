"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { nameWithPrefix } from "@/lib/name";
import { thMonthLabel, thDayLabel, groupByMonthDay } from "@/lib/th-month";
import type { PendingCertRow, HistoryCertRow } from "./page";

function bkkDisplay(iso: string): string {
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 16).replace("T", " ");
}

// "YYYY-MM-DDTHH:MM" Bangkok-local for an <input type="datetime-local">.
function bkkLocalForInput(iso: string): string {
  const bkk = new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 16);
}
// datetime-local back to an ISO instant at the Bangkok offset.
function inputToIso(local: string): string {
  return new Date(local + ":00+07:00").toISOString();
}

export default function TimeCertificationsClient({
  pending, history
}: {
  pending: PendingCertRow[];
  history: HistoryCertRow[];
}) {
  const router = useRouter();
  const { t } = useLang();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rejectForm, setRejectForm] = useState<{ id: number; note: string } | null>(null);
  // Per-row error state — keyed by cert id so two pending requests
  // can show independent errors. Was previously absent: a 4xx/5xx
  // from the API used to throw silently inside try, leaving the
  // user with a button that just stopped spinning. The 2026-05-30
  // SQLITE_CONSTRAINT_CHECK incident is the canonical example —
  // admin saw "approve doesn't work" with zero feedback.
  const [errorByCert, setErrorByCert] = useState<Record<number, string>>({});
  // Admin-editable apply-time per cert (datetime-local), prefilled from the
  // staff's proposed time. Lets the admin fix a wrong/unchanged time before
  // approving (owner 2026-06-09).
  const [editLocal, setEditLocal] = useState<Record<number, string>>({});

  function setError(certId: number, message: string | null) {
    setErrorByCert((prev) => {
      const next = { ...prev };
      if (message === null) delete next[certId];
      else next[certId] = message;
      return next;
    });
  }

  async function decide(
    certId: number,
    decision: "approved" | "rejected",
    note?: string,
    overrideIso?: string
  ) {
    setBusyId(certId);
    setError(certId, null);
    try {
      const res = await fetch(
        apiUrl(`/api/admin/persona/time-certification/${certId}/decide`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            decision_note: note?.trim() || undefined,
            override_ts: decision === "approved" ? overrideIso : undefined
          })
        }
      );
      if (!res.ok) {
        // Surface server-side error reason so admin can act on it,
        // not just "doesn't work". Common cases:
        //   400 invalid_body       → typically code bug, refresh
        //   403 branch_forbidden   → admin not assigned to this branch
        //   404 not_found          → cert was deleted concurrently
        //   409 already_decided    → race with another admin
        //   500                    → server fault — surface raw status
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) detail = String(j.error);
          if (j?.message) detail = String(j.message);
        } catch { /* non-JSON body, keep HTTP code */ }
        const friendly = {
          unauthenticated: "หมดเวลาเข้าระบบ — กรุณา login ใหม่",
          forbidden: "บัญชีนี้ไม่มีสิทธิ์อนุมัติ",
          branch_forbidden: "บัญชีนี้ไม่ได้ดูแลสาขาของคำขอนี้",
          not_found: "ไม่พบคำขอ — อาจถูกลบไปแล้ว ลองรีเฟรช",
          already_decided: "คำขอนี้ถูกตัดสินไปแล้ว ลองรีเฟรช",
          invalid_body: "ข้อมูลที่ส่งไม่ถูกต้อง"
        }[detail] || `เกิดข้อผิดพลาด (${detail})`;
        setError(certId, friendly);
        return;
      }
      router.refresh();
      setRejectForm(null);
    } catch (e) {
      // Network failure (offline, DNS, CORS) — different class from
      // server-returned errors.
      setError(certId, "เครือข่ายมีปัญหา — กรุณาลองอีกครั้ง");
      console.error("[time-cert] decide failed:", e);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
      {pending.length === 0 && (
        <div className="card text-sm text-slate-400 text-center py-10">
          {t("admin.persona.timeCert.empty")}
        </div>
      )}
      {pending.map((r) => {
        const busy = busyId === r.id;
        const err = errorByCert[r.id];
        return (
          <div key={r.id} className="card border-l-4 border-amber-400 space-y-3">
            <div>
              <div className="text-xs text-slate-400 tracking-[0.5px] uppercase">
                {t("admin.persona.timeCert.requesterLabel")}
              </div>
              <div className="font-bold text-slate-800 text-sm mt-0.5">
                {nameWithPrefix(r.requester_prefix, r.requester_name)}
              </div>
            </div>

            {r.kind === "missing" ? (
              // Forgot-to-punch request: no original entry — they're asking
              // to ADD the missing clock-in/out (owner 2026-06-08).
              <div className="text-sm">
                <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-sky-100 text-sky-700">
                  {r.entry_type === "out" ? "ลืมลงเวลาออก" : "ลืมลงเวลาเข้า"}
                </span>
                <div className="mt-1.5">
                  <span className="text-slate-500 text-xs">เวลาที่ขอเพิ่ม:</span>{" "}
                  <span className="font-mono font-bold text-emerald-700">{bkkDisplay(r.proposed_ts)}</span>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-[10px] uppercase tracking-[1px] text-slate-500 font-bold">
                    {t("admin.persona.timeCert.original")}
                  </div>
                  <div className="font-mono mt-0.5">{r.original_ts ? bkkDisplay(r.original_ts) : "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[1px] text-emerald-700 font-bold">
                    {t("admin.persona.timeCert.proposed")}
                  </div>
                  <div className="font-mono mt-0.5 text-emerald-700 font-bold">
                    {bkkDisplay(r.proposed_ts)}
                  </div>
                </div>
              </div>
            )}

            <div className="bg-amber-50 border border-amber-200 rounded p-2.5">
              <div className="text-[10px] uppercase tracking-[1px] text-amber-700 font-bold mb-1">
                {t("admin.persona.timeCert.reasonLabel")}
              </div>
              <div className="text-sm text-slate-800 whitespace-pre-wrap">{r.reason}</div>
            </div>

            {/* Admin can adjust the exact time before approving — covers
                certs where staff left the time unchanged or typed it wrong
                (owner 2026-06-09). Default = the staff's proposed time. */}
            <div>
              <label className="text-[10px] uppercase tracking-[1px] text-slate-500 font-bold block mb-1">
                เวลาที่จะบันทึก (แก้ได้ก่อนอนุมัติ)
              </label>
              <input
                type="datetime-local"
                className="input text-sm"
                value={editLocal[r.id] ?? bkkLocalForInput(r.proposed_ts)}
                onChange={(e) => setEditLocal((p) => ({ ...p, [r.id]: e.target.value }))}
              />
            </div>

            {err && (
              <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700 flex items-start gap-2">
                <span className="font-bold flex-shrink-0">⚠</span>
                <span className="flex-1">{err}</span>
                <button
                  type="button"
                  onClick={() => setError(r.id, null)}
                  className="text-rose-400 hover:text-rose-600 font-bold flex-shrink-0"
                  aria-label="ปิดข้อความ"
                >×</button>
              </div>
            )}

            {rejectForm?.id === r.id ? (
              <div className="space-y-2 bg-rose-50/50 border border-rose-200 rounded-lg p-3">
                <textarea
                  className="input text-sm"
                  rows={2}
                  maxLength={500}
                  placeholder={t("admin.persona.timeCert.rejectNotePlaceholder")}
                  value={rejectForm.note}
                  onChange={(e) => setRejectForm({ ...rejectForm, note: e.target.value })}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setRejectForm(null)}
                    disabled={busy}
                    className="btn-secondary flex-1 text-sm"
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => decide(r.id, "rejected", rejectForm.note)}
                    disabled={busy}
                    className="btn-danger flex-1 text-sm"
                  >
                    {busy ? t("common.submitting") : t("admin.persona.timeCert.rejectSubmit")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setRejectForm({ id: r.id, note: "" })}
                  disabled={busy}
                  className="btn-secondary flex-1 text-sm"
                >
                  {t("admin.persona.timeCert.reject")}
                </button>
                <button
                  type="button"
                  onClick={() => decide(r.id, "approved", undefined, inputToIso(editLocal[r.id] ?? bkkLocalForInput(r.proposed_ts)))}
                  disabled={busy}
                  className="btn-primary flex-1 text-sm"
                >
                  {busy ? t("common.submitting") : t("admin.persona.timeCert.approve")}
                </button>
              </div>
            )}
          </div>
        );
      })}
      </div>

      {/* History — decided certs, so admin can audit what happened
          (owner 2026-06-15). Shows type (เข้า/ออก), date, who decided. */}
      {history.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-bold text-slate-800 text-sm">ประวัติการรับรองเวลา</h2>
          {groupByMonthDay(history, (h) => h.decided_at ?? h.proposed_ts).map(({ mk, days }, i) => (
            <details key={mk} open={i === 0} className="card">
              <summary className="cursor-pointer font-semibold text-slate-700 text-sm select-none">
                {thMonthLabel(mk)}{" "}
                <span className="text-[11px] text-slate-400 font-normal">
                  · {days.reduce((s, [, rs]) => s + rs.length, 0)} รายการ
                </span>
              </summary>
              <div className="mt-2 space-y-3">
                {days.map(([d, rows]) => (
                  <div key={d}>
                    <div className="text-[11px] font-bold text-slate-400 border-b border-slate-100 pb-1 mb-1">
                      {thDayLabel(d)}
                    </div>
                    <div className="divide-y divide-slate-100">
                      {rows.map((h) => (
              <div key={h.id} className="py-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                  h.status === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-600"
                }`}>
                  {h.status === "approved" ? "อนุมัติ" : "ไม่อนุมัติ"}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                  h.entry_type === "out" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"
                }`}>
                  {h.kind === "missing"
                    ? (h.entry_type === "out" ? "ลืมลงเวลาออก" : "ลืมลงเวลาเข้า")
                    : (h.entry_type === "out" ? "แก้เวลาออก" : "แก้เวลาเข้า")}
                </span>
                <span className="font-medium text-slate-700">{nameWithPrefix(h.requester_prefix, h.requester_name)}</span>
                <span className="text-xs text-slate-500 font-mono">{bkkDisplay(h.proposed_ts)}</span>
                {h.decided_by_name && (
                  <span className="text-[11px] text-slate-400 ml-auto">
                    โดย {h.decided_by_name}{h.decided_at ? ` · ${bkkDisplay(h.decided_at)}` : ""}
                  </span>
                )}
                {h.decision_note && (
                  <span className="basis-full text-[11px] italic text-slate-500">หมายเหตุ: {h.decision_note}</span>
                )}
              </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
