"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

type TimeEntry = { id: number; type: "in" | "out"; ts: string };

type Phase = "idle" | "pin" | "saving" | "replace" | "success" | "error" | "ot_ask" | "owl" | "swap";

type OwlPrompt = { kind: "missing_in" | "missing_out"; work_date: string };

type SwapCandidate = { user_id: number; name: string; sched_in: string; sched_out: string };
type SwapPrompt = {
  kind: "late_or_swap" | "early_or_swap";
  sched_start: string;
  actual: string;
  work_date: string;
  candidates: SwapCandidate[];
};

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
  geofenceLat,
  geofenceLng,
  geofenceRadiusMeters,
  qrEnabled,
  isPartTime,
  scheduledEnd,
  todayBkk
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
  /** Branch's configured geofence centre + radius. Used CLIENT-side
   *  to verify the captured GPS fix is actually inside the fence
   *  before showing the green "อยู่ในพื้นที่บริษัท" chip. Previously
   *  the chip turned green as soon as ANY fix was captured, which
   *  was misleading — the server-side fence check only runs on
   *  submit, so users saw "in zone" then got rejected with "out of
   *  zone" after typing their PIN. With the centre+radius mirrored
   *  here we can give honest feedback before they touch the keypad.
   *  Nulls = admin hasn't configured the fence yet → we fall back to
   *  "captured" without claiming in/out (server still enforces). */
  geofenceLat: number | null;
  geofenceLng: number | null;
  geofenceRadiusMeters: number;
  /** Whether the branch admin has enabled QR anti-cheat. When true
   *  the client shows a camera scanner that must produce a token
   *  matching the branch's clock_qr_token before submission. */
  qrEnabled: boolean;
  isPartTime: boolean;
  scheduledEnd: string | null;
  todayBkk: string;
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
              geofenceLat={geofenceLat}
              geofenceLng={geofenceLng}
              geofenceRadiusMeters={geofenceRadiusMeters}
              qrEnabled={qrEnabled}
              isPartTime={isPartTime}
              scheduledEnd={scheduledEnd}
              todayBkk={todayBkk}
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
  geofenceLat,
  geofenceLng,
  geofenceRadiusMeters,
  qrEnabled,
  isPartTime,
  scheduledEnd,
  todayBkk
}: {
  action: "in" | "out";
  correctable: boolean;
  onSuccess: () => void;
  branchName: string | null;
  geofenceEnabled: boolean;
  geofenceLat: number | null;
  geofenceLng: number | null;
  geofenceRadiusMeters: number;
  qrEnabled: boolean;
  isPartTime: boolean;
  scheduledEnd: string | null;
  todayBkk: string;
}) {
  const { t } = useLang();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [pin, setPin] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [actualAction, setActualAction] = useState<"in" | "out">(action);
  const [replaceState, setReplaceState] = useState<ReplaceState | null>(null);
  const [owlPrompt, setOwlPrompt] = useState<OwlPrompt | null>(null);
  // Shift-swap / late-early prompt (owner 2026-06-08).
  const [swapPrompt, setSwapPrompt] = useState<SwapPrompt | null>(null);
  const [swapStep, setSwapStep] = useState<"ask" | "pickFriend">("ask");
  const [swapFriend, setSwapFriend] = useState<number | "">("");
  const [swapBusy, setSwapBusy] = useState(false);
  const [swapErr, setSwapErr] = useState<string | null>(null);

  // OT prompt (PT clocking out after scheduled end).
  const [otStep, setOtStep] = useState<"ask" | "enter">("ask");
  const [otUntil, setOtUntil] = useState("");
  const [otBusy, setOtBusy] = useState(false);
  const [otErr, setOtErr] = useState<string | null>(null);

  function finishOt() {
    setPhase("success");
    setTimeout(onSuccess, 1500);
  }
  async function submitOt() {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(otUntil)) {
      setOtErr(t("staff.persona.ot.needTime"));
      return;
    }
    setOtBusy(true);
    setOtErr(null);
    try {
      const res = await fetch(apiUrl("/api/persona/ot-requests"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ work_date: todayBkk, requested_until: otUntil })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) finishOt();
      else setOtErr(j?.error ?? t("common.error"));
    } catch {
      setOtErr(t("common.error"));
    } finally {
      setOtBusy(false);
    }
  }

  // Resolve a schedule-deviation prompt: record late / early / swap.
  async function submitResolve(resolution: "late" | "early" | "swap", friendId?: number) {
    if (!swapPrompt) return;
    setSwapBusy(true);
    setSwapErr(null);
    try {
      const res = await fetch(apiUrl("/api/persona/attendance-resolve"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          work_date: swapPrompt.work_date,
          resolution,
          ...(friendId ? { friend_user_id: friendId } : {})
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setSwapErr(
          j?.error === "friend_no_shift" ? "เพื่อนคนนี้ไม่มีกะในวันนี้"
          : j?.error === "friend_required" ? "กรุณาเลือกเพื่อน"
          : t("common.error")
        );
        return;
      }
      setPhase("success");
      setTimeout(onSuccess, 1500);
    } catch {
      setSwapErr(t("common.error"));
    } finally {
      setSwapBusy(false);
    }
  }

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

  // Whether each gate has been satisfied (or is irrelevant). Note
  // gpsReady here is just "did we get a position fix"; the actual
  // in-fence check happens in inZone (below) and is folded into
  // gatesReady further down so the keypad refuses input when we
  // KNOW the user will be rejected.
  const gpsReady = !geofenceEnabled || gpsCoords != null;
  const qrReady = !qrEnabled || qrToken != null;

  // ── Client-side geofence check (haversine) ────────────────────────
  // Run on every captured fix so the chip shows in/out of zone
  // BEFORE the user types their PIN. Same formula as the server's
  // /api/persona/clock route — we mirror the calculation here so
  // the answers line up. Returns:
  //   true  — fix is inside (or fence not configured / disabled)
  //   false — fix is outside the configured fence
  //
  // We widen the effective radius by the GPS accuracy reading
  // (same widening the server applies) so a noisy 30m-accuracy
  // fix at the edge of a 100m fence still reads "in zone" instead
  // of flickering. Without this widening the chip can flip back
  // and forth on every refresh as the accuracy varies.
  function haversineMeters(
    lat1: number, lng1: number, lat2: number, lng2: number
  ): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // null = "we don't know yet" (no GPS fix or fence misconfigured) —
  // chip shows pending/amber. true/false = definitive in/out → chip
  // shows green/red.
  const inZone: boolean | null =
    !geofenceEnabled                ? true   // gate off entirely
    : !gpsCoords                    ? null   // no fix yet
    : geofenceLat == null || geofenceLng == null
                                    ? null   // admin hasn't set centre
    : haversineMeters(gpsCoords.lat, gpsCoords.lng, geofenceLat, geofenceLng)
        <= geofenceRadiusMeters + gpsCoords.accuracy;

  // Geofence chip should show red when EITHER:
  //   - we computed locally that the user is outside the fence, OR
  //   - the server already rejected a submit with out_of_geofence
  // The second case used to be the only signal — but it only fired
  // AFTER the user wasted a PIN entry. Adding the first lets us warn
  // before they touch the keypad.
  const geofenceErrorActive =
    inZone === false
    || (!!errorMsg && errorMsg === t("staff.persona.gps.outOfRange"));

  // Gates are ready when every enabled gate is satisfied. For the
  // geofence we require BOTH a captured fix AND a local in-zone
  // verdict — refusing keypad input until we're confident the
  // server will accept saves the user from tapping their PIN just
  // to be told they're in the wrong place.
  const geofenceSatisfied = !geofenceEnabled || inZone === true;
  const gatesReady = geofenceSatisfied && qrReady;

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
        // Clear any lingering geofence error so the chip flips from
        // red to green cleanly once the user moves into range and
        // taps retry. Other error kinds (wrong_pin, rate_limited)
        // we leave alone — they're not GPS-related.
        setErrorMsg((prev) =>
          prev === t("staff.persona.gps.outOfRange") ? null : prev
        );
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
      // น้องฮูก forgot-to-punch nudge takes priority — it routes the
      // staff to certify the missing punch (owner 2026-06-08).
      if (data.owl && (data.owl.kind === "missing_in" || data.owl.kind === "missing_out")) {
        setOwlPrompt(data.owl as OwlPrompt);
        setPhase("owl");
        return;
      }
      // Schedule-deviation prompt (late/early vs swap) — clock-in only.
      if (data.swap && (data.swap.kind === "late_or_swap" || data.swap.kind === "early_or_swap")) {
        setSwapPrompt(data.swap as SwapPrompt);
        setSwapStep("ask");
        setSwapFriend("");
        setSwapErr(null);
        setPhase("swap");
        return;
      }
      // OT prompt — PT clocked out past their scheduled shift end by
      // more than the 5-min grace (so the time would otherwise be cut at
      // the scheduled end). The pay engine pays it at the regular rate up
      // to 8h and the OT rate only beyond 8h.
      if (data.action === "out" && isPartTime && scheduledEnd) {
        const bkkNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
        const nowMins = bkkNow.getUTCHours() * 60 + bkkNow.getUTCMinutes();
        const [eh, em] = scheduledEnd.split(":").map(Number);
        const schedMins = (eh || 0) * 60 + (em || 0);
        if (nowMins > schedMins + 5) {
          setOtStep("ask");
          setOtUntil("");
          setOtErr(null);
          setPhase("ot_ask");
          return;
        }
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

  // ── OT prompt (late clock-out, PT) ──────────
  if (phase === "ot_ask") {
    return (
      <div className="bg-rose-50 border-2 border-rose-200 rounded-2xl p-4 space-y-3 text-left">
        <div className="text-sm text-slate-800 leading-relaxed">
          {t("staff.persona.ot.askBody")}
        </div>
        {otStep === "ask" ? (
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              onClick={finishOt}
              className="py-3 rounded-xl bg-white border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 active:scale-95 transition"
            >
              {t("staff.persona.ot.no")}
            </button>
            <button
              onClick={() => { setOtStep("enter"); setOtUntil(scheduledEnd ?? ""); }}
              className="py-3 rounded-xl bg-brand text-white text-sm font-bold active:scale-95 transition"
            >
              {t("staff.persona.ot.yes")}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="text-xs text-slate-600">{t("staff.persona.ot.untilLabel")}</label>
            <input
              type="time"
              value={otUntil}
              onChange={(e) => setOtUntil(e.target.value)}
              className="input text-center text-lg"
            />
            <p className="text-[11px] text-amber-700">
              {t("staff.persona.ot.warnAfter")}
            </p>
            {otErr && <p className="text-rose-600 text-sm">{otErr}</p>}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                onClick={finishOt}
                disabled={otBusy}
                className="py-3 rounded-xl bg-white border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                {t("staff.persona.ot.skip")}
              </button>
              <button
                onClick={submitOt}
                disabled={otBusy}
                className="py-3 rounded-xl bg-brand text-white text-sm font-bold disabled:opacity-50"
              >
                {otBusy ? t("common.submitting") : t("staff.persona.ot.submit")}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── น้องฮูก: forgot-to-punch nudge ──────────
  // Shown right after the punch commits when an incomplete day is
  // detected. Soft, formal copy (no disciplinary language) + a route to
  // certify the missing punch (owner 2026-06-08).
  if (phase === "owl" && owlPrompt) {
    const isOut = owlPrompt.kind === "missing_out";
    const certType = isOut ? "out" : "in";
    const [yy, mm, dd] = owlPrompt.work_date.split("-");
    const dateLabel = `${dd}/${mm}/${String(Number(yy) + 543).slice(2)}`;
    return (
      <div className="bg-sky-50 border-2 border-sky-200 rounded-2xl p-4 space-y-3 text-left">
        <div className="text-sm font-bold text-sky-900">น้องฮูกแจ้งเตือน</div>
        <div className="text-sm text-slate-700 leading-relaxed">
          {isOut
            ? `พบว่าเมื่อวันที่ ${dateLabel} ยังไม่มีการลงเวลาออกงาน ระบบได้บันทึกไว้เป็นประวัติแล้ว รบกวนพี่กดรับรองเวลาออกให้เรียบร้อย และอย่าลืมลงเวลาออกทุกครั้งนะคะ`
            : `พบว่าวันนี้มีการลงเวลาออกงาน แต่ยังไม่มีเวลาเข้างาน ระบบได้บันทึกไว้เป็นประวัติแล้ว รบกวนพี่กดรับรองเวลาเข้าให้เรียบร้อยค่ะ`}
        </div>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            onClick={onSuccess}
            className="py-3 rounded-xl bg-white border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 active:scale-95 transition"
          >
            รับทราบ
          </button>
          <button
            onClick={() =>
              router.push(
                `/staff/persona/time-certification?missing=1&type=${certType}&date=${owlPrompt.work_date}`
              )
            }
            className="py-3 rounded-xl bg-brand text-white text-sm font-bold active:scale-95 transition"
          >
            ไปรับรองเวลา
          </button>
        </div>
      </div>
    );
  }

  // ── น้องฮูก: late/early vs shift-swap ────────
  if (phase === "swap" && swapPrompt) {
    const isLate = swapPrompt.kind === "late_or_swap";
    return (
      <div className="bg-sky-50 border-2 border-sky-200 rounded-2xl p-4 space-y-3 text-left">
        <div className="text-sm font-bold text-sky-900">น้องฮูกสอบถาม</div>
        <div className="text-sm text-slate-700 leading-relaxed">
          ตามตารางเวรพี่เข้างาน <b>{swapPrompt.sched_start}</b> น. แต่ลงเวลาจริง <b>{swapPrompt.actual}</b> น.
          {isLate ? " — พี่มาสาย หรือสลับกะกับเพื่อนคะ?" : " (ก่อนเวลา) — พี่มาก่อนเวลา หรือสลับกะกับเพื่อนคะ?"}
        </div>
        {swapErr && <div className="text-rose-600 text-sm">{swapErr}</div>}
        {swapStep === "ask" ? (
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              onClick={() => submitResolve(isLate ? "late" : "early")}
              disabled={swapBusy}
              className="py-3 rounded-xl bg-white border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 active:scale-95 transition disabled:opacity-50"
            >
              {isLate ? "มาสาย" : "มาก่อนเวลา"}
            </button>
            <button
              onClick={() => { setSwapStep("pickFriend"); setSwapErr(null); }}
              disabled={swapBusy}
              className="py-3 rounded-xl bg-brand text-white text-sm font-bold active:scale-95 transition disabled:opacity-50"
            >
              สลับกะกับเพื่อน
            </button>
          </div>
        ) : swapPrompt.candidates.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-amber-700">
              ไม่พบเพื่อนที่มีกะในวันนี้ — รบกวนแจ้งแอดมินเพื่อปรับเวลาให้ค่ะ
            </p>
            <button onClick={onSuccess} className="btn-secondary w-full text-sm">ปิด</button>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="text-xs text-slate-600">
              สลับกะกับใคร? (ระบบจะลงเวลาตามกะของเพื่อนคนนั้นให้)
            </label>
            <select
              className="input"
              value={swapFriend}
              onChange={(e) => setSwapFriend(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">— เลือกเพื่อน —</option>
              {swapPrompt.candidates.map((c) => (
                <option key={c.user_id} value={c.user_id}>
                  {c.name} (กะ {c.sched_in}–{c.sched_out})
                </option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                onClick={() => { setSwapStep("ask"); setSwapErr(null); }}
                disabled={swapBusy}
                className="py-3 rounded-xl bg-white border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                ย้อนกลับ
              </button>
              <button
                onClick={() => swapFriend ? submitResolve("swap", swapFriend) : setSwapErr("กรุณาเลือกเพื่อน")}
                disabled={swapBusy}
                className="py-3 rounded-xl bg-brand text-white text-sm font-bold disabled:opacity-50"
              >
                {swapBusy ? t("common.submitting") : "ยืนยัน"}
              </button>
            </div>
          </div>
        )}
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

      {/* Anti-cheat gate status — single centered banner per gate.
          GateChip now has 3 visual states for the geofence:
            • ready (green) — gpsCoords captured + no error
            • error (red)   — out_of_geofence error pending
            • pending (amber) — initial / re-checking
          That collapses what used to be "chip + duplicate errorMsg line"
          into one source of truth so the user never sees contradictory
          green/red messages at the same time. */}
      {(geofenceEnabled || qrEnabled) && (
        <div className="flex flex-col items-center gap-1.5">
          {geofenceEnabled && (
            <GateChip
              tone={
                // Use the locally-computed inZone so the chip's
                // green/red answer comes from haversine, NOT from
                // "did we get a fix". geofenceErrorActive already
                // folds in both inZone=false and the server's
                // out_of_geofence error, so this branch order is:
                //   error  → user is outside fence (local or server)
                //   ready  → inside fence (locally verified)
                //   pending → no fix yet, or fence misconfigured
                geofenceErrorActive ? "error"
                  : inZone === true ? "ready"
                  : "pending"
              }
              label={
                geofenceErrorActive
                  ? t("staff.persona.gps.outOfRange")
                  : inZone === true
                    ? t("staff.persona.gps.ready")
                    : (gpsStatus ?? t("staff.persona.gps.waitingForLocation"))
              }
              actionLabel={inZone === true ? null : t("staff.persona.gps.retry")}
              onAction={captureGps}
            />
          )}
          {qrEnabled && (
            <GateChip
              tone={qrToken ? "ready" : "pending"}
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
      {/* Don't repeat the geofence error here — the chip above is
          already in red showing the same thing. Other error kinds
          (wrong PIN, rate-limited, etc.) still render here. */}
      {errorMsg && !geofenceErrorActive && (
        <div className="text-red-600 text-sm font-medium whitespace-pre-line text-center">{errorMsg}</div>
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
// on the PIN screen. Receives `tone` (3-state visual: green ready,
// red error, amber pending) + a label describing the current state,
// plus an optional inline action button (retry GPS, rescan QR).
//
// Earlier API was a `ready` boolean (2 states only); we extended to
// 3 tones so the geofence chip can render the out-of-zone error
// directly here instead of duplicating it as a separate red text
// below the PIN dots.
function GateChip({
  tone,
  label,
  actionLabel,
  onAction
}: {
  tone: "ready" | "pending" | "error";
  label: string;
  actionLabel: string | null;
  onAction: () => void;
}) {
  const cls =
    tone === "ready"   ? "bg-emerald-50 border-emerald-200 text-emerald-800"
    : tone === "error" ? "bg-rose-50 border-rose-300 text-rose-700"
    :                    "bg-amber-50 border-amber-200 text-amber-800";
  const icon =
    tone === "ready"   ? "✓"
    : tone === "error" ? "✗"
    :                    "○";
  return (
    <div className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg border w-full ${cls}`}>
      <span className="font-bold">{icon}</span>
      <span className="flex-1 text-center">{label}</span>
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
