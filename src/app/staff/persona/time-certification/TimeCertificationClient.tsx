"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

type EntryRow = {
  id: number;
  type: "in" | "out";
  ts: string;
  branch_id: number | null;
};
type CertRow = {
  id: number;
  entry_id: number | null;
  proposed_ts: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  decided_at: string | null;
  decision_note: string | null;
};

// Bangkok "YYYY-MM-DD HH:MM" from an ISO string. The <input type=
// "datetime-local"> wants a value in this shape (without timezone)
// so admin/staff sees + edits the local-wall-clock time directly
// rather than wrestling with UTC offsets.
function bkkLocalForInput(iso: string): string {
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:MM'
}

function bkkDisplay(iso: string): string {
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 16).replace("T", " ");
}

// Bangkok calendar date (YYYY-MM-DD) of an ISO instant.
function bkkDateOf(iso: string): string {
  return new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

// Convert datetime-local string ("2026-05-13T08:32") back to a
// proper ISO with the Bangkok offset, so the server sees the same
// instant the user picked on their phone.
function inputToIso(local: string): string {
  return new Date(local + ":00+07:00").toISOString();
}

// Combine a date (YYYY-MM-DD) + time (HH:MM) into an ISO instant at the
// Bangkok offset — for filing a forgotten clock-in/out (owner 2026-06-08).
function dateTimeToIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00+07:00`).toISOString();
}
const BKK_TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

type FlagRow = {
  id: number;
  work_date: string;
  kind: string;
  detail: string | null;
  resolved_at: string | null;
  created_at: string;
};

const FLAG_KIND_LABEL: Record<string, string> = {
  missing_in: "ไม่ได้ลงเวลาเข้างาน",
  missing_out: "ไม่ได้ลงเวลาออกงาน",
  late: "เข้างานสาย",
  early: "เข้างานก่อนเวลา",
  swap: "สลับกะกับเพื่อน"
};

export default function TimeCertificationClient({
  entries,
  certs,
  pendingEntryIds,
  initialMissing = null,
  flags = []
}: {
  entries: EntryRow[];
  certs: CertRow[];
  pendingEntryIds: number[];
  initialMissing?: { entryType: "in" | "out"; date: string } | null;
  flags?: FlagRow[];
}) {
  const router = useRouter();
  const { t } = useLang();
  const pendingSet = new Set(pendingEntryIds);
  const [form, setForm] = useState<{
    entryId: number;
    originalTs: string;
    proposedLocal: string;
    reason: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Set when a forgot-clock-IN was self-certified with immediate effect, so we
  // can nudge the staff straight back to the clock to punch out.
  const [immediateOk, setImmediateOk] = useState(false);
  // Forgot-to-punch flow: file a request to ADD a clock-in/out that was
  // never recorded (owner 2026-06-08). Distinct from `form` (correct an
  // existing punch).
  const [missingForm, setMissingForm] = useState<{
    entryType: "in" | "out";
    date: string;
    time: string;
    reason: string;
  } | null>(
    initialMissing
      ? { entryType: initialMissing.entryType, date: initialMissing.date, time: "", reason: "" }
      : null
  );

  // Detect which punch is missing for a Bangkok date, from the staff's own
  // entries — so the missing-punch form can LOCK to the side that's actually
  // missing instead of letting them pick the wrong one (owner 2026-06-15:
  // "ถ้าลืมลงเข้า มีแค่รับรองเข้า / ถ้าลืมลงออก มีแค่รับรองออก").
  // Zero-punch day → treat as a missing IN: forgot to clock in entirely, so
  // certify the IN first (it takes effect immediately, then they clock out).
  function missingInfoForDate(date: string): {
    missing: "in" | "out" | null; reason: "ok" | "complete";
  } {
    const day = entries.filter((e) => bkkDateOf(e.ts) === date);
    const hasIn = day.some((e) => e.type === "in");
    const hasOut = day.some((e) => e.type === "out");
    if (hasIn && !hasOut) return { missing: "out", reason: "ok" };
    if (hasOut && !hasIn) return { missing: "in", reason: "ok" };
    if (hasIn && hasOut) return { missing: null, reason: "complete" };
    return { missing: "in", reason: "ok" };
  }

  function openForm(entry: EntryRow) {
    setForm({
      entryId: entry.id,
      originalTs: entry.ts,
      proposedLocal: bkkLocalForInput(entry.ts),
      reason: ""
    });
    setMsg(null);
  }

  async function submit() {
    if (!form) return;
    if (form.reason.trim().length < 3) {
      setMsg({ kind: "err", text: t("staff.persona.timeCert.reasonTooShort") });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/persona/time-certification"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry_id: form.entryId,
          proposed_ts: inputToIso(form.proposedLocal),
          reason: form.reason.trim()
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({
          kind: "err",
          text: j.error === "already_pending"
            ? t("staff.persona.timeCert.alreadyPending")
            : t("common.error")
        });
        return;
      }
      setMsg({ kind: "ok", text: t("staff.persona.timeCert.submitted") });
      setForm(null);
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally {
      setBusy(false);
    }
  }

  async function submitMissing() {
    if (!missingForm) return;
    if (!missingForm.date || !missingForm.time) {
      setMsg({ kind: "err", text: "กรุณาเลือกวันที่และเวลา" });
      return;
    }
    // Type is DERIVED from the day's punches, never picked freely — you can
    // only certify the side that's actually missing (owner 2026-06-15). A
    // zero-punch day resolves to a missing IN (owner 2026-07-18).
    const info = missingInfoForDate(missingForm.date);
    if (!info.missing) {
      setMsg({ kind: "err",
        text: "วันนี้ลงเวลาครบทั้งเข้า-ออกแล้ว — ถ้าเวลาผิดให้ใช้ \"แก้ไขเวลา\" รายการด้านล่าง" });
      return;
    }
    if (missingForm.reason.trim().length < 3) {
      setMsg({ kind: "err", text: t("staff.persona.timeCert.reasonTooShort") });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/persona/time-certification"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "missing",
          entry_type: info.missing,
          work_date: missingForm.date,
          proposed_ts: dateTimeToIso(missingForm.date, missingForm.time),
          reason: missingForm.reason.trim()
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const m =
          j.error === "punch_exists"
            ? "วันนั้นมีการลงเวลาประเภทนี้อยู่แล้ว — ใช้การแก้ไขเวลาแทน"
            : j.error === "no_opposite_punch"
            ? "เพิ่มได้เฉพาะวันที่มีลงเวลาอีกด้านไว้แล้ว (เช่น ลงเข้าแล้วแต่ลืมลงออก)"
            : j.error === "already_pending"
            ? t("staff.persona.timeCert.alreadyPending")
            : j.error === "date_mismatch"
            ? "วันที่และเวลาที่กรอกไม่ตรงกัน"
            : t("common.error");
        setMsg({ kind: "err", text: m });
        return;
      }
      if (j.immediate) {
        // Forgot clock-IN → recorded live. Send them back to clock OUT.
        setImmediateOk(true);
        setMsg({ kind: "ok", text: "บันทึกเวลาเข้าแล้ว กลับไปกดออกงานได้เลย" });
      } else {
        setMsg({ kind: "ok", text: t("staff.persona.timeCert.submitted") });
      }
      setMissingForm(null);
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Form modal (rendered inline) ── */}
      {form && (
        <div className="card space-y-3 border-l-4 border-amber-400">
          <h2 className="font-bold text-slate-800 text-sm">
            {t("staff.persona.timeCert.formTitle")}
          </h2>
          <div className="text-xs text-slate-600">
            {t("staff.persona.timeCert.originalLabel")}:{" "}
            <span className="font-mono font-bold">{bkkDisplay(form.originalTs)}</span>
          </div>
          <div>
            <label className="label">{t("staff.persona.timeCert.proposedLabel")}</label>
            <input
              type="datetime-local"
              className="input"
              value={form.proposedLocal}
              onChange={(e) => setForm({ ...form, proposedLocal: e.target.value })}
            />
          </div>
          <div>
            <label className="label">{t("staff.persona.timeCert.reasonLabel")}</label>
            <textarea
              className="input text-sm"
              rows={3}
              maxLength={500}
              placeholder={t("staff.persona.timeCert.reasonPlaceholder")}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setForm(null)}
              disabled={busy}
              className="btn-secondary flex-1 text-sm"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="btn-primary flex-1 text-sm"
            >
              {busy ? t("common.submitting") : t("staff.persona.timeCert.submit")}
            </button>
          </div>
        </div>
      )}

      {msg && (
        <div className={`text-sm text-center ${
          msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
        }`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}
          {msg.text}
        </div>
      )}

      {immediateOk && (
        <div className="text-center">
          <a href="/staff/persona"
            className="inline-block text-sm font-bold bg-brand hover:bg-amber-700 text-white px-5 py-2.5 rounded-lg">
            กลับไปหน้าลงเวลา → กดออกงาน
          </a>
        </div>
      )}

      {/* ── Forgot to clock in/out — file a NEW punch (owner 2026-06-08) ── */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-bold text-slate-800 text-sm">ลืมลงเวลาเข้า/ออก?</h2>
          {!missingForm && (
            <button
              type="button"
              onClick={() =>
                setMissingForm({ entryType: "out", date: BKK_TODAY, time: "", reason: "" })
              }
              className="text-xs px-3 py-1.5 rounded-lg border border-brand text-brand font-bold hover:bg-amber-50 whitespace-nowrap"
            >
              เพิ่มเวลาที่ลืมลง
            </button>
          )}
        </div>

        {missingForm ? (() => {
          const dayInfo = missingInfoForDate(missingForm.date);
          return (
          <div className="space-y-3">
            <div>
              <label className="label">ประเภท (ระบบตรวจจากวันที่ให้อัตโนมัติ)</label>
              {dayInfo.missing ? (
                <>
                  <div className={`py-2 px-3 rounded-lg text-sm font-bold border ${
                    dayInfo.missing === "in"
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : "bg-rose-50 text-rose-700 border-rose-200"
                  }`}>
                    {dayInfo.missing === "in" ? "ลืมลงเวลาเข้า" : "ลืมลงเวลาออก"}
                  </div>
                  <p className="text-[11px] text-slate-500 leading-relaxed mt-1.5">
                    {dayInfo.missing === "in"
                      ? "รับรองเวลาเข้าแล้วมีผลทันที กลับไปกดออกงานได้เลย — ระบบบันทึกไว้เป็นประวัติการลงเวลาที่ไม่เหมาะสม"
                      : "เมื่อแอดมินอนุมัติ ระบบจะบันทึกเวลาและคำนวณเงินเดือนให้อัตโนมัติ"}
                  </p>
                </>
              ) : (
                <div className="py-2 px-3 rounded-lg text-xs bg-amber-50 text-amber-800 border border-amber-200 leading-relaxed">
                  วันนี้ลงเวลาครบทั้งเข้า-ออกแล้ว — ถ้าเวลาผิด ให้ใช้ “แก้ไขเวลา” ที่รายการด้านล่าง
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">วันที่</label>
                <input
                  type="date"
                  className="input"
                  max={BKK_TODAY}
                  value={missingForm.date}
                  onChange={(e) => setMissingForm({ ...missingForm, date: e.target.value })}
                />
              </div>
              <div>
                <label className="label">
                  {dayInfo.missing === "in" ? "เวลาเข้า" : dayInfo.missing === "out" ? "เวลาออก" : "เวลา"}
                </label>
                <input
                  type="time"
                  className="input"
                  value={missingForm.time}
                  onChange={(e) => setMissingForm({ ...missingForm, time: e.target.value })}
                />
              </div>
            </div>
            <div>
              <label className="label">{t("staff.persona.timeCert.reasonLabel")}</label>
              <textarea
                className="input text-sm"
                rows={2}
                maxLength={500}
                placeholder={t("staff.persona.timeCert.reasonPlaceholder")}
                value={missingForm.reason}
                onChange={(e) => setMissingForm({ ...missingForm, reason: e.target.value })}
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMissingForm(null)}
                disabled={busy}
                className="btn-secondary flex-1 text-sm"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={submitMissing}
                disabled={busy || !dayInfo.missing}
                className="btn-primary flex-1 text-sm disabled:opacity-50"
              >
                {busy ? t("common.submitting") : t("staff.persona.timeCert.submit")}
              </button>
            </div>
          </div>
          );
        })() : (
          <p className="text-[11px] text-slate-400 leading-relaxed">
            ลืมกดเข้า? รับรองเวลาเข้าได้เลย ระบบบันทึกทันทีแล้วกลับไปกดออกงานต่อได้ —
            ส่วนการลืมกดออก ระบบจะบันทึกเมื่อแอดมินอนุมัติ ทุกครั้งจะถูกบันทึกเป็นประวัติการลงเวลาที่ไม่เหมาะสม
          </p>
        )}
      </div>

      {/* ── ประวัติการลงเวลาผิดปกติ (น้องฮูกบันทึกไว้) ── */}
      {flags.length > 0 && (
        <div className="card space-y-2">
          <h2 className="font-bold text-slate-800 text-sm">ประวัติการลงเวลาที่ไม่เหมาะสม</h2>
          <p className="text-[11px] text-rose-600 leading-relaxed">
            ระบบบันทึกการลงเวลาที่ไม่เหมาะสมไว้เป็นสถิติ — การลงเวลาไม่ครบหรือสลับกะกันเองโดยไม่แจ้งบ่อยครั้ง
            อาจมีผลทางวินัย ไม่ได้ปล่อยผ่านนะครับ โปรดปรับปรุงและกดรับรองเวลาให้ครบถ้วน
          </p>
          <div className="space-y-1.5">
            {flags.map((f) => {
              const [yy, mm, dd] = f.work_date.split("-");
              const dateLabel = `${dd}/${mm}/${String(Number(yy) + 543).slice(2)}`;
              return (
                <div
                  key={f.id}
                  className="flex items-start justify-between gap-2 py-1.5 border-b border-slate-100 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-slate-700">{FLAG_KIND_LABEL[f.kind] ?? f.kind}</div>
                    {f.detail && <div className="text-[11px] text-slate-400">{f.detail}</div>}
                  </div>
                  <span className="font-mono text-xs text-slate-500 whitespace-nowrap mt-0.5">{dateLabel}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Recent entries — pick one to certify ── */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">
          {t("staff.persona.timeCert.recentTitle")}
        </h2>
        {entries.length === 0 ? (
          <div className="text-sm text-slate-400 text-center py-6">
            {t("staff.persona.timeCert.noEntries")}
          </div>
        ) : (
          <div className="space-y-1.5">
            {entries.map((e) => {
              const pending = pendingSet.has(e.id);
              return (
                <div
                  key={e.id}
                  className="flex items-center justify-between gap-2 py-1.5 border-b border-slate-100 last:border-b-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                      e.type === "in"
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-amber-100 text-amber-700"
                    }`}>
                      {e.type === "in" ? "เข้า" : "ออก"}
                    </span>
                    <span className="font-mono text-sm">{bkkDisplay(e.ts)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => openForm(e)}
                    disabled={pending}
                    className="text-xs px-2.5 py-1 rounded border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    {pending
                      ? t("staff.persona.timeCert.pendingChip")
                      : t("staff.persona.timeCert.requestBtn")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── My certification history ── */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">
          {t("staff.persona.timeCert.historyTitle")}
        </h2>
        {certs.length === 0 ? (
          <div className="text-sm text-slate-400 text-center py-6">
            {t("staff.persona.timeCert.noHistory")}
          </div>
        ) : (
          <div className="space-y-2">
            {certs.map((c) => (
              <div key={c.id} className="border border-slate-200 rounded-lg p-2.5 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-xs text-slate-600">
                    {bkkDisplay(c.proposed_ts)}
                  </div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold whitespace-nowrap ${
                    c.status === "pending" ? "bg-amber-100 text-amber-700"
                    : c.status === "approved" ? "bg-emerald-100 text-emerald-700"
                    : "bg-rose-100 text-rose-700"
                  }`}>
                    {t(`staff.persona.timeCert.status.${c.status}`)}
                  </span>
                </div>
                <div className="text-xs text-slate-700">{c.reason}</div>
                {c.decision_note && (
                  <div className="text-[11px] text-slate-500 italic">
                    {t("staff.persona.timeCert.adminNote")}: "{c.decision_note}"
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
