"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// Post-shift checklist (เช็คลิสต์หลังเลิกงาน). Mirrors ShiftOpenForm
// without the "yesterday's closing" prefill — the closing-drawer
// amount the staff types here becomes the next day's "ยอดเงินปิดกะ
// เมื่อวาน" prefill on the pre-shift form.

type ChecklistItem = { id: number; label: string; kind: "checkbox" | "text" };

export default function ShiftCloseForm({
  branchId, branchName, closerName, checklistItems
}: {
  branchId: number;
  branchName: string;
  closerName: string;
  checklistItems: ChecklistItem[];
}) {
  const router = useRouter();
  const { t } = useLang();

  const [closingAmount, setClosingAmount] = useState<string>("");
  // Service Charge collected from POS today. Optional — empty string
  // = staff skipped (admin can fill at /admin/persona/service-charge).
  // Persisted into daily_service_charge via the daily-report API.
  const [svcAmount, setSvcAmount] = useState<string>("");
  const [checked, setChecked] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(checklistItems.map((it) => [it.id, false]))
  );
  const [notes, setNotes] = useState<Record<number, string>>(() =>
    Object.fromEntries(checklistItems.map((it) => [it.id, ""]))
  );
  // See ShiftOpenForm for the rationale — text items keep their value
  // here and we mirror them into the (checked, note) payload at submit
  // so downstream renderers (LINE Flex, audit) don't need to know about
  // kinds.
  const [textValues, setTextValues] = useState<Record<number, string>>(() =>
    Object.fromEntries(checklistItems.map((it) => [it.id, ""]))
  );
  const [openNotes, setOpenNotes] = useState<Record<number, boolean>>({});
  const [errorIds, setErrorIds] = useState<Record<number, boolean>>({});

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [done, setDone] = useState(false);

  function toggleAll(value: boolean) {
    setChecked((prev) => ({
      ...prev,
      ...Object.fromEntries(
        checklistItems
          .filter((it) => it.kind === "checkbox")
          .map((it) => [it.id, value])
      )
    }));
  }

  function parseAmount(s: string): number | null {
    const trimmed = s.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed.replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const missingNoteIds = checklistItems
      .filter((it) => {
        if (it.kind === "text") return !((textValues[it.id] || "").trim());
        return !checked[it.id] && !((notes[it.id] || "").trim());
      })
      .map((it) => it.id);
    if (missingNoteIds.length > 0) {
      setErrorIds(Object.fromEntries(missingNoteIds.map((id) => [id, true])));
      setOpenNotes((prev) => ({
        ...prev,
        ...Object.fromEntries(missingNoteIds.map((id) => [id, true]))
      }));
      setMsg({
        kind: "err",
        text: t("staff.persona.shift.open.requireNoteForUnchecked", {
          n: String(missingNoteIds.length)
        })
      });
      return;
    }
    setErrorIds({});
    setBusy(true);
    try {
      const closingParsed = parseAmount(closingAmount);
      const svcParsed = parseAmount(svcAmount);
      const checklistPayload = checklistItems.map((it) => {
        if (it.kind === "text") {
          const value = (textValues[it.id] || "").trim();
          return {
            label: it.label,
            kind: "text" as const,
            checked: !!value,
            note: value || null
          };
        }
        const note = (notes[it.id] || "").trim();
        return {
          label: it.label,
          kind: "checkbox" as const,
          checked: !!checked[it.id],
          note: note ? note : null
        };
      });

      const res = await fetch(apiUrl("/api/persona/daily-report"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "shift_close",
          branch_id: branchId,
          data: {
            closing_drawer_amount: closingParsed,
            // Send SVC only when staff actually filled it. null on the
            // server means "don't touch daily_service_charge"; an
            // explicit 0 means "we collected nothing today" and is
            // recorded for transparency.
            service_charge_amount: svcParsed,
            checklist: checklistPayload
          }
        })
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 409 && j.error === "already_submitted") {
        router.refresh();
        return;
      }
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: t("common.error") });
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card text-center space-y-3">
        <div className="text-5xl">✓</div>
        <h2 className="text-xl font-bold text-slate-800">
          {t("staff.persona.shiftReport.submitted.title")}
        </h2>
        <p className="text-sm text-slate-600">
          {t("staff.persona.shiftReport.submitted.body", {
            type: t("staff.persona.shiftReport.typeLabel.shiftClose"),
            branch: branchName
          })}
        </p>
        <button type="button" onClick={() => router.push("/staff/persona")}
          className="btn-secondary w-full">
          {t("common.back")}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="card space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">{t("staff.persona.shift.open.field.opener")}</label>
            <input type="text" className="input bg-slate-50 text-slate-500"
              value={closerName} readOnly />
          </div>
          <div>
            <label className="label">
              {t("staff.persona.shift.open.field.branch")}
            </label>
            <input type="text" className="input bg-slate-50 text-slate-500"
              value={branchName} readOnly />
          </div>
        </div>

        <div>
          <label className="label">{t("staff.persona.shift.close.field.closingDrawer")} *</label>
          <input type="number" inputMode="decimal" min={0} step="0.01"
            required
            className="input"
            value={closingAmount}
            placeholder="0.00"
            onChange={(e) => setClosingAmount(e.target.value)} />
          <p className="text-[10px] text-slate-400 mt-1">
            {t("staff.persona.shift.close.field.closingDrawerHint")}
          </p>
        </div>

        {/* Service Charge — ผู้ปิดกะกรอกยอด SVC จาก POS ของวันนี้.
            ใช้คำนวณส่วนแบ่งให้พนักงานสาขานี้ในเดือนนี้ (60% สำหรับพนักงาน
            หารตาม ชม.ทำงาน, 40% เข้าบริษัท). เว้นว่างได้ถ้ายังไม่รู้ยอด —
            แอดมินจะกรอกย้อนหลังที่ /admin/persona/service-charge ได้. */}
        <div>
          <label className="label">{t("staff.persona.shift.close.field.svcAmount")}</label>
          <input type="number" inputMode="decimal" min={0} step="0.01"
            className="input"
            value={svcAmount}
            placeholder="0.00"
            onChange={(e) => setSvcAmount(e.target.value)} />
          <p className="text-[10px] text-slate-400 mt-1">
            {t("staff.persona.shift.close.field.svcAmountHint")}
          </p>
        </div>
      </div>

      {checklistItems.length > 0 ? (
        <div className="card space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="font-bold text-slate-800">
              {t("staff.persona.shift.close.checklistTitle")}
            </h2>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => toggleAll(true)}
                className="px-2.5 py-1 text-xs rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50">
                {t("staff.persona.shift.open.checkAll")}
              </button>
              <button type="button" onClick={() => toggleAll(false)}
                className="px-2.5 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50">
                {t("staff.persona.shift.open.uncheckAll")}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {checklistItems.map((it) => {
              const hasError = !!errorIds[it.id];
              if (it.kind === "text") {
                const value = textValues[it.id] || "";
                const filled = value.trim().length > 0;
                const cls = hasError
                  ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                  : filled
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-slate-200 hover:border-slate-300";
                return (
                  <div
                    key={it.id}
                    className={`rounded-xl border-[1.5px] transition p-3 ${cls}`}
                  >
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      {it.label}
                    </label>
                    <input
                      type="text"
                      className={`input text-sm ${hasError ? "border-rose-400 focus:border-rose-500" : ""}`}
                      maxLength={500}
                      value={value}
                      placeholder={t("staff.persona.shift.open.textValuePlaceholder")}
                      onChange={(e) => {
                        setTextValues((prev) => ({
                          ...prev,
                          [it.id]: e.target.value
                        }));
                        if (e.target.value.trim() && hasError) {
                          setErrorIds((prev) => {
                            const next = { ...prev };
                            delete next[it.id];
                            return next;
                          });
                        }
                      }}
                    />
                    {hasError && (
                      <p className="text-[10px] text-rose-600 font-medium mt-1">
                        {t("staff.persona.shift.open.textValueRequired")}
                      </p>
                    )}
                  </div>
                );
              }
              const isChecked = !!checked[it.id];
              const note = notes[it.id] || "";
              const hasNote = note.trim().length > 0;
              const isOpen = !!openNotes[it.id];
              const containerCls = hasError
                ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                : isChecked
                  ? "border-emerald-300 bg-emerald-50"
                  : hasNote
                    ? "border-amber-300 bg-amber-50"
                    : "border-slate-200 hover:border-slate-300";
              return (
                <div
                  key={it.id}
                  className={`rounded-xl border-[1.5px] transition ${containerCls}`}
                >
                  <label className="flex items-center gap-3 p-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="w-5 h-5 flex-shrink-0"
                      checked={isChecked}
                      onChange={(e) => {
                        setChecked((prev) => ({
                          ...prev,
                          [it.id]: e.target.checked
                        }));
                        if (e.target.checked) {
                          setErrorIds((prev) => {
                            const next = { ...prev };
                            delete next[it.id];
                            return next;
                          });
                        }
                      }}
                    />
                    <span className="text-sm flex-1">{it.label}</span>
                    <span className={`text-xs font-bold ${
                      isChecked ? "text-emerald-700"
                        : hasNote ? "text-amber-700"
                        : "text-slate-400"
                    }`}>
                      {isChecked ? "✓" : hasNote ? "📝" : "✗"}
                    </span>
                  </label>

                  <div className="px-3 pb-2.5 -mt-1 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setOpenNotes((prev) => ({
                        ...prev,
                        [it.id]: !prev[it.id]
                      }))}
                      className={`text-[11px] font-medium tracking-[0.5px] ${
                        hasNote ? "text-amber-700" : "text-slate-400 hover:text-brand"
                      }`}
                    >
                      {hasNote
                        ? `📝 ${t("staff.persona.shift.open.noteExists")}`
                        : `+ ${t("staff.persona.shift.open.addNote")}`}
                    </button>
                    {hasNote && !isOpen && (
                      <span className="text-[11px] text-amber-700/80 truncate flex-1">
                        — {note.trim()}
                      </span>
                    )}
                  </div>

                  {isOpen && (
                    <div className="px-3 pb-3">
                      <textarea
                        className={`input text-sm ${hasError ? "border-rose-400 focus:border-rose-500" : ""}`}
                        rows={2}
                        maxLength={500}
                        placeholder={t("staff.persona.shift.open.notePlaceholder")}
                        value={note}
                        onChange={(e) => {
                          setNotes((prev) => ({
                            ...prev,
                            [it.id]: e.target.value
                          }));
                          if (e.target.value.trim() && hasError) {
                            setErrorIds((prev) => {
                              const next = { ...prev };
                              delete next[it.id];
                              return next;
                            });
                          }
                        }}
                      />
                      <p className={`text-[10px] mt-1 ${
                        hasError ? "text-rose-600 font-medium" : "text-slate-400"
                      }`}>
                        {hasError
                          ? t("staff.persona.shift.open.requireNoteRowHint")
                          : t("staff.persona.shift.open.noteHint")}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-slate-400">
            {t("staff.persona.shift.open.checklistHint")}
          </p>
        </div>
      ) : (
        <div className="card text-xs text-slate-500 text-center">
          {t("staff.persona.shift.open.checklistEmptyForBranch")}
        </div>
      )}

      {msg && (
        <div className={`text-sm text-center ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
        </div>
      )}

      <button type="submit" disabled={busy}
        className="btn-primary w-full text-base py-3.5">
        {busy
          ? t("staff.persona.shift.open.submitting")
          : t("staff.persona.shift.close.submit")}
      </button>
    </form>
  );
}
