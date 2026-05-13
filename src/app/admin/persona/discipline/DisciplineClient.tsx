"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

type StaffOption = { id: number; display_name: string; username: string; employment_type: string | null };
type WarningRow = {
  id: number;
  ref_no: string | null;
  severity: "verbal" | "written_1" | "written_2" | "final";
  title: string;
  recipient: string;
  issued_by: string;
  issued_at: string;
  acknowledged_at: string | null;
  acknowledged_method: "pin_explicit" | "auto_on_leave" | null;
};

const SEVERITY_LABEL: Record<WarningRow["severity"], string> = {
  verbal:    "ตักเตือนด้วยวาจา",
  written_1: "ลายลักษณ์อักษร ครั้งที่ 1",
  written_2: "ลายลักษณ์อักษร ครั้งที่ 2",
  final:     "หนังสือเตือนครั้งสุดท้าย"
};

export default function DisciplineClient({
  staffList, warnings
}: {
  staffList: StaffOption[];
  warnings: WarningRow[];
}) {
  const router = useRouter();
  const { t } = useLang();
  const [pending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [userId, setUserId] = useState<number | "">("");
  const [severity, setSeverity] = useState<WarningRow["severity"]>("written_1");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");

  function refresh() { startTransition(() => router.refresh()); }

  async function issue() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/discipline"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: Number(userId),
          severity, title: title.trim(), body: body.trim(),
          reason_category: reason.trim() || null,
          effective_date: effectiveDate || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? t("common.error")); return; }
      setCreating(false);
      setUserId(""); setTitle(""); setBody(""); setReason(""); setEffectiveDate("");
      setSeverity("written_1");
      refresh();
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="flex justify-end">
        {!creating && (
          <button type="button" onClick={() => setCreating(true)}
            className="text-sm px-3 py-1.5 rounded bg-brand text-white font-bold hover:opacity-90">
            + {t("admin.persona.discipline.issue")}
          </button>
        )}
      </div>

      {creating && (
        <div className="card border-rose-300 bg-rose-50/30 space-y-3">
          <h2 className="font-bold text-rose-800">
            ⚠ {t("admin.persona.discipline.issueTitle")}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">{t("admin.persona.discipline.field.recipient")} *</label>
              <select className="input" value={userId}
                onChange={(e) => setUserId(e.target.value === "" ? "" : Number(e.target.value))}>
                <option value="">— {t("admin.persona.discipline.pickStaff")} —</option>
                {staffList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name} @{s.username}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t("admin.persona.discipline.field.severity")} *</label>
              <select className="input" value={severity}
                onChange={(e) => setSeverity(e.target.value as WarningRow["severity"])}>
                <option value="verbal">{SEVERITY_LABEL.verbal}</option>
                <option value="written_1">{SEVERITY_LABEL.written_1}</option>
                <option value="written_2">{SEVERITY_LABEL.written_2}</option>
                <option value="final">{SEVERITY_LABEL.final}</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label">{t("admin.persona.discipline.field.title")} *</label>
              <input className="input" value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder={t("admin.persona.discipline.titlePlaceholder")} />
            </div>
            <div className="sm:col-span-2">
              <label className="label">{t("admin.persona.discipline.field.body")} *</label>
              <textarea className="input" rows={6} value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={5000}
                placeholder={t("admin.persona.discipline.bodyPlaceholder")} />
              <p className="text-[10px] text-slate-500 mt-1">
                {t("admin.persona.discipline.bodyHint")}
              </p>
            </div>
            <div>
              <label className="label">{t("admin.persona.discipline.field.category")}</label>
              <select className="input" value={reason}
                onChange={(e) => setReason(e.target.value)}>
                <option value="">—</option>
                <option value="lateness">มาสายเกินกำหนด</option>
                <option value="absence">ขาดงาน/ลางานผิดกติกา</option>
                <option value="conduct">ประพฤติตัวไม่เหมาะสม</option>
                <option value="performance">ประสิทธิภาพการทำงาน</option>
                <option value="safety">ความปลอดภัย</option>
                <option value="other">อื่นๆ</option>
              </select>
            </div>
            <div>
              <label className="label">{t("admin.persona.discipline.field.effectiveDate")}</label>
              <input type="date" className="input" value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)} />
            </div>
          </div>
          {err && <div className="text-sm text-rose-600">✗ {err}</div>}
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => setCreating(false)}
              className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm">
              {t("common.cancel")}
            </button>
            <button type="button" disabled={busy || !userId || !title.trim() || !body.trim()}
              onClick={issue}
              className="flex-1 py-2.5 rounded-lg bg-rose-600 text-white text-sm font-bold disabled:opacity-50">
              {busy ? t("common.submitting") : "📨 " + t("admin.persona.discipline.issueAndNotify")}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h2 className="font-bold text-slate-800 text-sm mb-3">
          {t("admin.persona.discipline.listTitle")} ({warnings.length})
        </h2>
        {warnings.length === 0 ? (
          <div className="text-sm text-slate-400 text-center py-8">
            {t("admin.persona.discipline.empty")}
          </div>
        ) : (
          <ul className="space-y-2">
            {warnings.map((w) => (
              <li key={w.id} className="border border-slate-200 rounded-lg p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    {w.ref_no && (
                      <div className="text-[10px] font-mono text-slate-400 mb-0.5">#{w.ref_no}</div>
                    )}
                    <div className="font-bold text-slate-800">{w.title}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {w.recipient} · {SEVERITY_LABEL[w.severity]}
                    </div>
                    <div className="text-[10px] text-slate-400 mt-1">
                      {t("admin.persona.discipline.issuedBy", { name: w.issued_by })}
                      · {new Date(w.issued_at).toISOString().slice(0, 16).replace("T", " ")}
                    </div>
                  </div>
                  <div>
                    {w.acknowledged_at ? (
                      <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                        w.acknowledged_method === "pin_explicit"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-amber-100 text-amber-700"
                      }`}>
                        ✓ {w.acknowledged_method === "pin_explicit"
                            ? t("admin.persona.discipline.ackPin")
                            : t("admin.persona.discipline.ackAuto")}
                      </span>
                    ) : (
                      <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-rose-100 text-rose-700">
                        ⏳ {t("admin.persona.discipline.pendingAck")}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
