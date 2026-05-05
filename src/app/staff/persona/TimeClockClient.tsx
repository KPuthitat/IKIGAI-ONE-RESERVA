"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

type TimeEntry = { id: number; type: "in" | "out"; ts: string };

type Phase = "idle" | "pin" | "saving" | "success" | "error";

export default function TimeClockClient({
  userName,
  hasPin,
  isCurrentlyIn,
  todayDone,
  entries
}: {
  userName: string;
  hasPin: boolean;
  isCurrentlyIn: boolean;
  todayDone: boolean;
  entries: TimeEntry[];
}) {
  const router = useRouter();
  const { t, formatDateLong } = useLang();
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const bkk = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const timeStr = bkk.toISOString().slice(11, 19);
  const dateStr = formatDateLong(bkk);

  // ── ถ้ายังไม่มี PIN → แสดงฟอร์มตั้ง PIN ────────────────────────────
  if (!hasPin) {
    return <PinSetup onDone={() => router.refresh()} />;
  }

  // ── การจัดกลุ่ม entries ตาม Bangkok local date สำหรับแสดงประวัติ ──
  const byDay: Record<string, TimeEntry[]> = {};
  for (const e of entries) {
    const d = new Date(new Date(e.ts).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    (byDay[d] ||= []).push(e);
  }
  const days = Object.keys(byDay).sort().reverse();

  const nextAction: "in" | "out" | "done" =
    todayDone ? "done" : isCurrentlyIn ? "out" : "in";

  return (
    <div className="space-y-4">
      <div className="card text-center">
        <div className="text-sm text-slate-500">{dateStr}</div>
        <div className="text-5xl font-bold tracking-wider text-slate-800 mt-2 tabular-nums">
          {timeStr}
        </div>
        <div className="mt-4">
          <StatusBadge state={nextAction} />
        </div>
        <p className="text-xs text-slate-400 mt-2">{userName}</p>

        <div className="mt-5">
          {nextAction === "done" ? (
            <div className="bg-slate-50 border border-slate-200 rounded-2xl py-6 px-4">
              <div className="text-3xl mb-2">✓</div>
              <div className="text-sm text-slate-600 whitespace-pre-line">
                {t("staff.persona.alreadyDoneToday")}
              </div>
            </div>
          ) : (
            // key={nextAction + entries.length} → บังคับ remount เมื่อ state เปลี่ยน
            // กัน ClockAction ค้างใน phase "success" หลัง router.refresh()
            <ClockAction
              key={`${nextAction}-${entries.length}`}
              action={nextAction}
              onSuccess={() => router.refresh()}
            />
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-3">{t("staff.persona.history7")}</h2>
        {days.length === 0 ? (
          <div className="text-slate-500 text-sm text-center py-4">{t("staff.persona.noHistory")}</div>
        ) : (
          <div className="space-y-3">
            {days.map((d) => {
              const dayEntries = byDay[d];
              const totalMins = computeTotalMinutes(dayEntries);
              return (
                <div key={d} className="border-b border-slate-100 pb-2 last:border-b-0">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-medium">{formatDateLong(d)}</span>
                    <span className="text-slate-500 text-xs">
                      {totalMins > 0
                        ? t("staff.persona.totalHM", { h: Math.floor(totalMins / 60), m: totalMins % 60 })
                        : ""}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {dayEntries.slice().sort((a, b) => a.ts.localeCompare(b.ts)).map((e) => (
                      <span
                        key={e.id}
                        className={`text-[11px] px-2 py-0.5 rounded ${
                          e.type === "in" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {e.type === "in" ? t("staff.persona.entry.in") : t("staff.persona.entry.out")}{" "}
                        {new Date(new Date(e.ts).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(11, 16)}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Status badge component ───────────────────────────────────────────
function StatusBadge({ state }: { state: "in" | "out" | "done" }) {
  const { t } = useLang();
  if (state === "in") {
    // not yet clocked in
    return (
      <span className="inline-block px-3 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-600">
        {t("staff.persona.notWorking")}
      </span>
    );
  }
  if (state === "out") {
    return (
      <span className="inline-block px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">
        {t("staff.persona.workingNow")}
      </span>
    );
  }
  return (
    <span className="inline-block px-3 py-1 rounded-full text-xs font-bold bg-slate-200 text-slate-500">
      {t("staff.persona.todayDone")}
    </span>
  );
}

// ── Clock action ─────────────────────────────────────────────────────
function ClockAction({
  action,
  onSuccess
}: { action: "in" | "out"; onSuccess: () => void }) {
  const { t } = useLang();
  const [phase, setPhase] = useState<Phase>("idle");
  const [pin, setPin] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Server-authoritative action จาก response — เผื่อ client prop เป็น stale
  const [actualAction, setActualAction] = useState<"in" | "out">(action);

  async function submitPin(currentPin: string) {
    setPhase("saving");
    setErrorMsg(null);
    try {
      const res = await fetch(apiUrl("/api/persona/clock"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: currentPin })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.error === "wrong_pin") {
          setErrorMsg(t("staff.persona.pinWrong"));
        } else if (data.error === "rate_limited") {
          setErrorMsg(t("staff.persona.tooManyAttempts", { n: data.retryAfterSec ?? 60 }));
        } else if (data.error === "already_done_today") {
          setErrorMsg(t("staff.persona.alreadyDoneToday"));
        } else {
          setErrorMsg(t("staff.persona.errorClock"));
        }
        setPhase("error");
        setPin("");
        setTimeout(() => setPhase("pin"), 2500);
        return;
      }
      // ใช้ action จริงจาก server (กัน mismatch กรณี client prop stale)
      if (data.action === "in" || data.action === "out") {
        setActualAction(data.action);
      }
      setPhase("success");
      setTimeout(onSuccess, 1500);
    } catch {
      setErrorMsg(t("staff.persona.errorClock"));
      setPhase("error");
      setTimeout(() => setPhase("pin"), 2500);
    }
  }

  function pressDigit(d: string) {
    if (phase !== "pin") return;
    if (pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    if (next.length === 4) submitPin(next);
  }
  function backspace() {
    if (phase !== "pin") return;
    setPin((p) => p.slice(0, -1));
  }

  if (phase === "idle") {
    return (
      <button
        onClick={() => setPhase("pin")}
        className={`w-full py-5 rounded-2xl text-lg font-bold transition active:scale-95 ${
          action === "in"
            ? "bg-emerald-500 hover:bg-emerald-600 text-white shadow-[0_4px_16px_rgba(16,185,129,.4)]"
            : "bg-amber-500 hover:bg-amber-600 text-white shadow-[0_4px_16px_rgba(245,158,11,.4)]"
        }`}
      >
        {action === "in" ? t("staff.persona.clockIn") : t("staff.persona.clockOut")}
      </button>
    );
  }

  if (phase === "success") {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-2xl py-6">
        <div className="text-4xl mb-2">✅</div>
        <div className="text-emerald-800 font-bold">
          {actualAction === "in" ? t("staff.persona.success.in") : t("staff.persona.success.out")}
        </div>
      </div>
    );
  }

  // phase = "pin" | "saving" | "error"
  return (
    <div className="space-y-3">
      <div className="text-sm text-slate-600">
        {action === "in" ? t("staff.persona.pinPrompt.in") : t("staff.persona.pinPrompt.out")}
      </div>

      <div className="flex justify-center gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`w-3.5 h-3.5 rounded-full border-2 ${
              i < pin.length ? "bg-brand border-brand" : "border-slate-300"
            }`}
          />
        ))}
      </div>

      {errorMsg && (
        <div className="text-red-600 text-sm font-medium whitespace-pre-line">{errorMsg}</div>
      )}

      <Keypad onDigit={pressDigit} onBackspace={backspace} disabled={phase !== "pin"} variant="light" />

      <button
        onClick={() => { setPhase("idle"); setPin(""); setErrorMsg(null); }}
        disabled={phase === "saving"}
        className="w-full py-2 text-sm text-slate-500 hover:text-slate-700"
      >{t("common.cancel")}</button>
    </div>
  );
}

// ── PIN setup form (first-time) ──────────────────────────────────────
function PinSetup({ onDone }: { onDone: () => void }) {
  const { t } = useLang();
  const [step, setStep] = useState<"enter" | "confirm">("enter");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function pressDigit(d: string) {
    if (busy) return;
    if (step === "enter") {
      if (pin.length >= 4) return;
      const next = pin + d;
      setPin(next);
      if (next.length === 4) {
        setStep("confirm");
        setErr(null);
      }
    } else {
      if (confirmPin.length >= 4) return;
      const next = confirmPin + d;
      setConfirmPin(next);
      if (next.length === 4) {
        if (next !== pin) {
          setErr(t("staff.persona.setupPin.mismatch"));
          setPin("");
          setConfirmPin("");
          setStep("enter");
        } else {
          save(next);
        }
      }
    }
  }
  function backspace() {
    if (step === "enter") setPin((p) => p.slice(0, -1));
    else setConfirmPin((p) => p.slice(0, -1));
  }

  async function save(p: string) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(apiUrl("/api/persona/set-pin"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: p })
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error || t("common.error"));
        setPin("");
        setConfirmPin("");
        setStep("enter");
        return;
      }
      // success → reload page
      onDone();
    } catch {
      setErr(t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  const currentLen = step === "enter" ? pin.length : confirmPin.length;

  return (
    <div className="card text-center">
      <div className="text-4xl mb-2">🔒</div>
      <h2 className="text-lg font-bold text-slate-800">{t("staff.persona.setupPin.title")}</h2>
      <p className="text-sm text-slate-500 mt-1">{t("staff.persona.setupPin.subtitle")}</p>

      <div className="mt-6 mb-3">
        <div className="text-xs text-slate-500 mb-2">
          {step === "enter" ? t("staff.persona.setupPin.enter") : t("staff.persona.setupPin.confirm")}
        </div>
        <div className="flex justify-center gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`w-3.5 h-3.5 rounded-full border-2 ${
                i < currentLen ? "bg-brand border-brand" : "border-slate-300"
              }`}
            />
          ))}
        </div>
      </div>

      {err && <div className="text-red-600 text-sm mb-3">{err}</div>}

      <Keypad onDigit={pressDigit} onBackspace={backspace} disabled={busy} variant="light" />
    </div>
  );
}

// ── Keypad component ─────────────────────────────────────────────────
function Keypad({
  onDigit, onBackspace, disabled, variant
}: {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  disabled: boolean;
  variant: "light" | "dark";
}) {
  const rows: Array<Array<string | null>> = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    [null, "0", "⌫"]
  ];
  const baseDigit = variant === "dark"
    ? "bg-white/[.1] text-white hover:bg-white/[.18]"
    : "bg-slate-100 text-slate-800 hover:bg-slate-200";
  const baseDel = variant === "dark"
    ? "bg-white/[.06] text-white/60 hover:bg-white/[.1]"
    : "bg-slate-50 text-slate-500 hover:bg-slate-100";
  return (
    <div className="grid grid-cols-3 gap-2.5 max-w-[280px] mx-auto">
      {rows.flat().map((k, i) => {
        if (k === null) return <div key={i} />;
        const isDel = k === "⌫";
        return (
          <button
            key={i}
            type="button"
            disabled={disabled}
            onClick={() => (isDel ? onBackspace() : onDigit(k))}
            className={`h-14 rounded-xl text-xl font-light transition active:scale-95 ${
              isDel ? baseDel : baseDigit
            } ${disabled ? "opacity-50" : ""}`}
          >
            {k}
          </button>
        );
      })}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────
function computeTotalMinutes(entries: TimeEntry[]): number {
  const sorted = entries.slice().sort((a, b) => a.ts.localeCompare(b.ts));
  let total = 0;
  let lastIn: number | null = null;
  for (const e of sorted) {
    if (e.type === "in") lastIn = new Date(e.ts).getTime();
    else if (e.type === "out" && lastIn !== null) {
      total += Math.floor((new Date(e.ts).getTime() - lastIn) / 60000);
      lastIn = null;
    }
  }
  return Math.max(0, total);
}
