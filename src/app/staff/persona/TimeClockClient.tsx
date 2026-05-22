"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

type TimeEntry = { id: number; type: "in" | "out"; ts: string };

type Phase = "idle" | "pin" | "saving" | "replace" | "success" | "error";

type ReplaceState = {
  pin: string;
  action: "in" | "out";
  existingTs: string;
  proposedTs: string;
};

const FIVE_MIN_MS = 5 * 60 * 1000;

// Format timestamp → "HH:MM" Bangkok local
function bkkTime(ts: string): string {
  return new Date(new Date(ts).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

export default function TimeClockClient({
  userName,
  hasPin,
  firstInTs,
  firstOutTs,
  entries,
  branchName,
  geofenceEnabled,
  qrEnabled
}: {
  userName: string;
  hasPin: boolean;
  firstInTs: string | null;
  firstOutTs: string | null;
  entries: TimeEntry[];
  /** Active-branch name shown in the on-site / off-site banners. */
  branchName: string | null;
  /** Whether the branch admin has enabled GPS anti-cheat. When true
   *  the client requests navigator.geolocation before submission and
   *  the server rejects clock-ins without a fix. */
  geofenceEnabled: boolean;
  /** Whether the branch admin has enabled QR anti-cheat. When true
   *  the client shows a camera scanner that must produce a token
   *  matching the branch's clock_qr_token before submission. */
  qrEnabled: boolean;
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

  if (!hasPin) {
    return <PinSetup onDone={() => router.refresh()} />;
  }

  // ── คำนวณ nextAction + correction window ทุกวินาที (re-render เพราะ now เปลี่ยน)
  const nowMs = now.getTime();
  const inAge = firstInTs ? nowMs - new Date(firstInTs).getTime() : Infinity;
  const outAge = firstOutTs ? nowMs - new Date(firstOutTs).getTime() : Infinity;

  let nextAction: "in" | "out" | "done";
  let inCorrectable = false;
  let outCorrectable = false;

  if (!firstInTs) {
    nextAction = "in";
  } else if (!firstOutTs) {
    if (inAge < FIVE_MIN_MS) {
      nextAction = "in";
      inCorrectable = true;
    } else {
      nextAction = "out";
    }
  } else {
    if (outAge < FIVE_MIN_MS) {
      nextAction = "out";
      outCorrectable = true;
    } else {
      nextAction = "done";
    }
  }

  const statusBadge: "in" | "out" | "done" =
    nextAction === "done"
      ? "done"
      : firstInTs && !firstOutTs
        ? "out"  // working now (ระหว่าง in กับ out)
        : "in";  // ยังไม่ทำงาน

  // กลุ่ม entries ตาม day สำหรับประวัติ
  const byDay: Record<string, TimeEntry[]> = {};
  for (const e of entries) {
    const d = new Date(new Date(e.ts).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    (byDay[d] ||= []).push(e);
  }
  const days = Object.keys(byDay).sort().reverse();

  return (
    <div className="space-y-4">
      <div className="card text-center">
        <div className="text-sm text-slate-500">{dateStr}</div>
        <div className="text-5xl font-bold tracking-wider text-slate-800 mt-2 tabular-nums">
          {timeStr}
        </div>
        <div className="mt-4">
          <StatusBadge state={statusBadge} />
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
            <ClockAction
              key={`${nextAction}-${firstInTs ?? ""}-${firstOutTs ?? ""}`}
              action={nextAction}
              correctable={nextAction === "in" ? inCorrectable : outCorrectable}
              onSuccess={() => router.refresh()}
              branchName={branchName}
              geofenceEnabled={geofenceEnabled}
              qrEnabled={qrEnabled}
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
                        {bkkTime(e.ts)}
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

function StatusBadge({ state }: { state: "in" | "out" | "done" }) {
  const { t } = useLang();
  if (state === "in") {
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
  correctable,
  onSuccess,
  branchName,
  geofenceEnabled,
  qrEnabled
}: {
  action: "in" | "out";
  correctable: boolean;
  onSuccess: () => void;
  branchName: string | null;
  geofenceEnabled: boolean;
  qrEnabled: boolean;
}) {
  const { t } = useLang();
  const [phase, setPhase] = useState<Phase>("idle");
  const [pin, setPin] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [actualAction, setActualAction] = useState<"in" | "out">(action);
  const [replaceState, setReplaceState] = useState<ReplaceState | null>(null);

  // GPS state (captured on-demand when geofenceEnabled). Stored as
  // numbers + accuracy so the API can widen the allowed radius by
  // the GPS uncertainty (avoids false rejects from a noisy reading).
  const [gpsCoords, setGpsCoords] = useState<{
    lat: number;
    lng: number;
    accuracy: number;
  } | null>(null);
  const [gpsStatus, setGpsStatus] = useState<string | null>(null);

  // QR token captured from the in-shop poster (when qrEnabled).
  const [qrToken, setQrToken] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  // Sub-phase tracking inside the "pin" stage — we surface a single
  // ClockAction component that walks the user through GPS → QR →
  // PIN in order, depending on which gates are enabled.
  const [showQrScanner, setShowQrScanner] = useState(false);

  // Whether each gate has been satisfied (or is irrelevant).
  const gpsReady = !geofenceEnabled || gpsCoords != null;
  const qrReady = !qrEnabled || qrToken != null;
  const gatesReady = gpsReady && qrReady;

  // Kick off GPS capture as soon as the user opens the clock-in flow.
  // Phones can take 5-10s to acquire a fresh fix outdoors / indoors;
  // by starting in parallel with PIN entry the wait is often
  // invisible. Runs only when geofenceEnabled and we haven't captured
  // yet (or had an error).
  function captureGps() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGpsStatus(t("staff.persona.gps.notSupported"));
      return;
    }
    setGpsStatus(t("staff.persona.gps.locating"));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsCoords({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        });
        // No accuracy-meters string here — the chip's ✓ icon and the
        // simplified "อยู่ในพื้นที่บริษัท" label carry the signal
        // already. Keeping setGpsStatus null avoids the redundant
        // line of text right next to the chip on the same screen.
        setGpsStatus(null);
      },
      (err) => {
        const map: Record<number, string> = {
          1: "staff.persona.gps.errPermission",
          2: "staff.persona.gps.errUnavailable",
          3: "staff.persona.gps.errTimeout"
        };
        setGpsStatus(t(map[err.code] || "staff.persona.gps.errGeneric"));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }
    );
  }

  // When the user taps Clock In / Out, kick off the parallel
  // captures so by the time they finish the PIN keypad the gates
  // are usually green.
  function onTapClockButton() {
    setPhase("pin");
    if (geofenceEnabled && !gpsCoords) captureGps();
  }

  async function callApi(currentPin: string, replaceTs?: boolean) {
    // Gate check just before submit — surfacing the unmet gate
    // inline keeps the PIN screen "almost ready" instead of failing
    // silently at the server.
    if (geofenceEnabled && !gpsCoords) {
      setErrorMsg(t("staff.persona.gps.required"));
      setPhase("pin");
      setPin("");
      return;
    }
    if (qrEnabled && !qrToken) {
      setErrorMsg(t("staff.persona.qr.required"));
      setPhase("pin");
      setPin("");
      return;
    }

    setPhase("saving");
    setErrorMsg(null);
    try {
      const body: Record<string, unknown> = { pin: currentPin };
      if (replaceTs !== undefined) body.replaceTs = replaceTs;
      if (gpsCoords) {
        body.lat = gpsCoords.lat;
        body.lng = gpsCoords.lng;
        body.gpsAccuracy = gpsCoords.accuracy;
      }
      if (qrToken) body.qrToken = qrToken;
      const res = await fetch(apiUrl("/api/persona/clock"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.error === "wrong_pin") setErrorMsg(t("staff.persona.pinWrong"));
        else if (data.error === "rate_limited") setErrorMsg(t("staff.persona.tooManyAttempts", { n: data.retryAfterSec ?? 60 }));
        else if (data.error === "already_done_today") setErrorMsg(t("staff.persona.alreadyDoneToday"));
        else if (data.error === "gps_required") setErrorMsg(t("staff.persona.gps.required"));
        else if (data.error === "out_of_geofence") {
          // Simplified copy — distance/radius detail dropped per
          // owner feedback. Staff only need the yes/no signal; the
          // forced GPS re-capture below already handles "you moved
          // closer, try again" without us having to print numbers.
          setErrorMsg(t("staff.persona.gps.outOfRange"));
          // Force re-capture — a stale reading from elsewhere on the
          // way to the shop shouldn't keep the staff stuck. Clear
          // gpsCoords so the next attempt asks the browser fresh.
          setGpsCoords(null);
        }
        else if (data.error === "qr_required") setErrorMsg(t("staff.persona.qr.required"));
        else if (data.error === "invalid_qr_token") {
          setErrorMsg(t("staff.persona.qr.invalid"));
          setQrToken(null);
        }
        else if (data.error === "geofence_misconfigured" || data.error === "qr_misconfigured") {
          setErrorMsg(t("staff.persona.errorMisconfigured"));
        }
        else setErrorMsg(t("staff.persona.errorClock"));
        setPhase("error");
        setPin("");
        setTimeout(() => setPhase("pin"), 2500);
        return;
      }

      // Server ขอ confirm replace (เจอ entry < 5 นาที)
      if (data.needsReplace) {
        setReplaceState({
          pin: currentPin,
          action: data.action,
          existingTs: data.existingTs,
          proposedTs: data.proposedTs
        });
        setPhase("replace");
        return;
      }

      // success
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
    if (next.length === 4) callApi(next);
  }
  function backspace() {
    if (phase !== "pin") return;
    setPin((p) => p.slice(0, -1));
  }

  // ── Idle: ปุ่มหลัก ─────────────────────────
  if (phase === "idle") {
    return (
      <>
        <button
          onClick={onTapClockButton}
          className={`w-full py-5 rounded-2xl text-lg font-bold transition active:scale-95 ${
            action === "in"
              ? "bg-emerald-500 hover:bg-emerald-600 text-white shadow-[0_4px_16px_rgba(16,185,129,.4)]"
              : "bg-amber-500 hover:bg-amber-600 text-white shadow-[0_4px_16px_rgba(245,158,11,.4)]"
          }`}
        >
          {action === "in" ? t("staff.persona.clockIn") : t("staff.persona.clockOut")}
        </button>
        {correctable && (
          <p className="text-xs text-slate-500 mt-2">
            {t("staff.persona.correctable")}
          </p>
        )}
        {(geofenceEnabled || qrEnabled) && (
          <p className="text-[11px] text-slate-400 mt-3">
            {t("staff.persona.antiCheatHint", {
              branch: branchName ?? "—"
            })}
          </p>
        )}
      </>
    );
  }

  // ── Replace dialog ──────────────────────────
  if (phase === "replace" && replaceState) {
    const existingHHMM = bkkTime(replaceState.existingTs);
    const proposedHHMM = bkkTime(replaceState.proposedTs);
    const isIn = replaceState.action === "in";
    return (
      <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4 space-y-3 text-left">
        <div className="text-sm text-amber-900 font-medium">
          {isIn
            ? t("staff.persona.replace.bodyIn", { existing: existingHHMM, proposed: proposedHHMM })
            : t("staff.persona.replace.bodyOut", { existing: existingHHMM, proposed: proposedHHMM })}
        </div>
        <div className="grid grid-cols-2 gap-2 pt-2">
          <button
            onClick={() => callApi(replaceState.pin, false)}
            className="py-3 rounded-xl bg-white border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 active:scale-95 transition"
          >
            {t("staff.persona.replace.keep", { time: existingHHMM })}
          </button>
          <button
            onClick={() => callApi(replaceState.pin, true)}
            className="py-3 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-sm font-bold active:scale-95 transition"
          >
            {t("staff.persona.replace.use", { time: proposedHHMM })}
          </button>
        </div>
      </div>
    );
  }

  // ── Success ─────────────────────────────────
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

  // ── PIN keypad (phase = pin | saving | error) ──
  return (
    <div className="space-y-3">
      <div className="text-sm text-slate-600">
        {action === "in" ? t("staff.persona.pinPrompt.in") : t("staff.persona.pinPrompt.out")}
      </div>

      {/* Anti-cheat gate status banners — shown above the PIN dots
          so staff knows what else is needed before tapping digits.
          Each gate renders as a coloured chip: amber while pending,
          emerald once satisfied, rose on hard failure. */}
      {(geofenceEnabled || qrEnabled) && (
        <div className="flex flex-col gap-1.5 text-left">
          {geofenceEnabled && (
            <GateChip
              ready={gpsCoords != null}
              label={
                // Simplified copy — staff only need to know "in zone /
                // out of zone". The accuracy / distance / radius detail
                // we used to dump here was cluttering the screen; the
                // gate icon (✓ / ○) carries the same yes/no signal in
                // half the visual space.
                gpsCoords
                  ? t("staff.persona.gps.ready")
                  : (gpsStatus ?? t("staff.persona.gps.waitingForLocation"))
              }
              actionLabel={gpsCoords ? null : t("staff.persona.gps.retry")}
              onAction={captureGps}
            />
          )}
          {qrEnabled && (
            <GateChip
              ready={qrToken != null}
              label={
                qrToken
                  ? t("staff.persona.qr.ready")
                  : (qrError ?? t("staff.persona.qr.scanPrompt"))
              }
              actionLabel={qrToken ? t("staff.persona.qr.rescan") : t("staff.persona.qr.openScanner")}
              onAction={() => {
                setQrError(null);
                setShowQrScanner(true);
              }}
            />
          )}
        </div>
      )}

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
      <Keypad
        onDigit={pressDigit}
        onBackspace={backspace}
        disabled={phase !== "pin" || !gatesReady}
        variant="light"
      />
      {!gatesReady && (
        <p className="text-[11px] text-amber-700 text-center">
          {t("staff.persona.gatesPending")}
        </p>
      )}
      <button
        onClick={() => { setPhase("idle"); setPin(""); setErrorMsg(null); }}
        disabled={phase === "saving"}
        className="w-full py-2 text-sm text-slate-500 hover:text-slate-700"
      >{t("common.cancel")}</button>

      {/* QR scanner modal — mounted only when needed to keep the
          html5-qrcode library out of the initial page bundle. */}
      {showQrScanner && (
        <QrScannerModal
          onScanned={(token) => {
            setQrToken(token);
            setShowQrScanner(false);
            setQrError(null);
          }}
          onClose={() => setShowQrScanner(false)}
          onError={(msg) => setQrError(msg)}
        />
      )}
    </div>
  );
}

// Single gate status chip — used for both GPS and QR checkpoints
// on the PIN screen. Receives `ready` (gate satisfied) + a label
// describing the current state, plus an optional inline action
// button (retry GPS, rescan QR).
function GateChip({
  ready,
  label,
  actionLabel,
  onAction
}: {
  ready: boolean;
  label: string;
  actionLabel: string | null;
  onAction: () => void;
}) {
  const cls = ready
    ? "bg-emerald-50 border-emerald-200 text-emerald-800"
    : "bg-amber-50 border-amber-200 text-amber-800";
  const icon = ready ? "✓" : "○";
  return (
    <div className={`flex items-center gap-2 text-[11px] px-2.5 py-1.5 rounded-lg border ${cls}`}>
      <span className="font-bold">{icon}</span>
      <span className="flex-1">{label}</span>
      {actionLabel && (
        <button
          type="button"
          onClick={onAction}
          className="text-[10px] underline hover:no-underline whitespace-nowrap"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

// QR scanner modal — lazy-imports html5-qrcode on mount. Stops the
// camera on unmount + on a successful scan to avoid hot devices.
function QrScannerModal({
  onScanned,
  onClose,
  onError
}: {
  onScanned: (token: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useLang();
  const [starting, setStarting] = useState(true);
  useEffect(() => {
    let html5Qr: { stop: () => Promise<void>; clear: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const mod = await import("html5-qrcode");
        if (cancelled) return;
        const scanner = new mod.Html5Qrcode("qr-reader-region");
        html5Qr = scanner;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: 220 },
          (decoded) => {
            // Stop camera before bubbling up; calling onScanned
            // would unmount us anyway, but stopping first avoids
            // a brief "camera still on" frame on slow phones.
            void scanner.stop().then(() => {
              scanner.clear();
              onScanned(decoded.trim());
            });
          },
          () => { /* swallow per-frame "no QR found" noise */ }
        );
        setStarting(false);
      } catch (err) {
        const m = err instanceof Error ? err.message : "camera unavailable";
        onError(t("staff.persona.qr.cameraError", { message: m }));
        onClose();
      }
    })();
    return () => {
      cancelled = true;
      if (html5Qr) {
        void html5Qr.stop().catch(() => { /* ignore */ });
        html5Qr.clear();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-4 w-full max-w-sm space-y-3">
        <div className="text-center">
          <h3 className="font-bold text-slate-800 text-sm">
            {t("staff.persona.qr.modalTitle")}
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {t("staff.persona.qr.modalHelp")}
          </p>
        </div>
        <div
          id="qr-reader-region"
          className="rounded-xl overflow-hidden bg-slate-900 aspect-square"
        />
        {starting && (
          <p className="text-[11px] text-slate-500 text-center">
            {t("staff.persona.qr.starting")}
          </p>
        )}
        <button
          type="button"
          onClick={onClose}
          className="btn-secondary w-full text-sm"
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

// ── PIN setup form ───────────────────────────────────────────────────
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
