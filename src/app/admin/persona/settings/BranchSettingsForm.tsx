"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import Switch from "@/app/components/Switch";

// Client form for editing per-branch PERSONA settings. Today this
// covers just the 2 readiness round times — staff form subtitles +
// LINE Flex card titles consume these. Both are HH:MM type=time
// inputs so mobile gets the native time picker.
//
// "Reset" button reverts both fields to the system defaults
// (11:30 / 16:00) — common case when a branch wants the original
// rounds back after experimenting.

const DEFAULT_MORNING = "11:30";
const DEFAULT_AFTERNOON = "16:00";

// Default CI hex used when admin hasn't picked a brand colour yet.
// Matches COLOR_INK_700 in line.ts so the preview chip and the
// fallback Flex header agree visually.
const DEFAULT_BRAND_COLOR = "#1a1a2e";

export default function BranchSettingsForm({
  morningTime,
  afternoonTime,
  brandColor,
  latitude,
  longitude,
  geofenceRadiusMeters,
  geofenceEnabled,
  clockQrToken,
  clockQrEnabled,
  requireServiceCharge,
  requireYesterdayClosing,
  requireMorningOpening,
  requireTodayClosing,
  requireDailyRevenue,
  attendanceSummaryTime,
  shiftNotifyTime,
  pendingDigestTime,
  branchName
}: {
  morningTime: string;
  afternoonTime: string;
  brandColor: string | null;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusMeters: number;
  geofenceEnabled: boolean;
  clockQrToken: string | null;
  clockQrEnabled: boolean;
  requireServiceCharge: boolean;
  requireYesterdayClosing: boolean;
  requireMorningOpening: boolean;
  requireTodayClosing: boolean;
  requireDailyRevenue: boolean;
  attendanceSummaryTime: string | null;
  shiftNotifyTime: string | null;
  pendingDigestTime: string | null;
  branchName: string;
}) {
  const router = useRouter();
  const { t } = useLang();

  const [morning, setMorning] = useState(morningTime);
  const [afternoon, setAfternoon] = useState(afternoonTime);
  // Brand colour stored as nullable hex. Empty string in the input
  // means "use default" — we normalise to null on submit.
  const [color, setColor] = useState<string>(brandColor || "");

  // ── Time Clock anti-cheat fields ─────────────────────────────────
  // GPS coords as strings so the input can be empty (NULL on save).
  // Browser's geolocation API returns numbers; we stringify on capture.
  const [lat, setLat] = useState<string>(latitude == null ? "" : String(latitude));
  const [lng, setLng] = useState<string>(longitude == null ? "" : String(longitude));
  const [radius, setRadius] = useState<number>(geofenceRadiusMeters);
  const [geoOn, setGeoOn] = useState<boolean>(geofenceEnabled);
  const [qrToken, setQrToken] = useState<string>(clockQrToken || "");
  const [qrOn, setQrOn] = useState<boolean>(clockQrEnabled);
  // require_service_charge toggle (added 2026-05-23). When ON, the
  // shift_close staff form shows a mandatory "ยอดเซอร์วิสชาร์จ"
  // field that feeds the staff-share calculator. When OFF, the
  // field is hidden and admin backfills back-office.
  const [svcRequired, setSvcRequired] = useState<boolean>(requireServiceCharge);
  // Required-financial-checklist toggles (2026-05-25). DEFAULT ON in
  // schema so every existing branch picks them up; admin flips off
  // when not needed (e.g. cashless-only branch).
  const [yClosingReq, setYClosingReq] = useState<boolean>(requireYesterdayClosing);
  const [mOpeningReq, setMOpeningReq] = useState<boolean>(requireMorningOpening);
  const [tClosingReq, setTClosingReq] = useState<boolean>(requireTodayClosing);
  // require_daily_revenue toggle (2026-05-28). When ON, the shift_close
  // form shows the optional "ยอดขายวันนี้" field which feeds
  // branch_daily_revenue + appears as a headline figure on the LINE
  // Flex card. OFF = field hidden, admin backfills via /admin/ascenda.
  const [dailyRevReq, setDailyRevReq] = useState<boolean>(requireDailyRevenue);
  // Daily attendance summary time (TC-6) — HH:MM Bangkok. Empty
  // string = disable feature. Recommended value = branch's typical
  // shift start time + 1 hour, but admin is free to pick anything.
  const [summaryTime, setSummaryTime] = useState<string>(
    attendanceSummaryTime || ""
  );
  // Per-shift personal LINE reminder time. Empty = auto off.
  const [shiftNotify, setShiftNotify] = useState<string>(
    shiftNotifyTime || ""
  );
  // Daily pending-requests digest time (owner 2026-06-05) — HH:MM
  // Bangkok. Empty = digest off. Sends a summary of staff requests
  // still waiting (shift-change + pending leave) to the exec/HR group.
  const [pendingDigest, setPendingDigest] = useState<string>(
    pendingDigestTime || ""
  );
  // Per-section status text for the geolocate button (success/error
  // feedback after the navigator.geolocation callback returns).
  const [geoStatus, setGeoStatus] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Pristine = same as last saved values. Disables Save when there's
  // nothing to write, which keeps the activity log from filling up
  // with no-op entries when admin clicks Save twice in a row.
  const pristine =
    morning === morningTime &&
    afternoon === afternoonTime &&
    (color || null) === (brandColor || null) &&
    lat === (latitude == null ? "" : String(latitude)) &&
    lng === (longitude == null ? "" : String(longitude)) &&
    radius === geofenceRadiusMeters &&
    geoOn === geofenceEnabled &&
    (qrToken || null) === (clockQrToken || null) &&
    qrOn === clockQrEnabled &&
    svcRequired === requireServiceCharge &&
    yClosingReq === requireYesterdayClosing &&
    mOpeningReq === requireMorningOpening &&
    tClosingReq === requireTodayClosing &&
    dailyRevReq === requireDailyRevenue &&
    (summaryTime || null) === (attendanceSummaryTime || null) &&
    (shiftNotify || null) === (shiftNotifyTime || null) &&
    (pendingDigest || null) === (pendingDigestTime || null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      // Parse lat/lng from string inputs. Empty string → null (the
      // server treats null as "geofence centre unset"). Non-empty
      // strings that don't parse as numbers fall through to NaN
      // which the Zod schema on the server rejects with a clear
      // error message — caught here below.
      const latNum = lat.trim() === "" ? null : Number(lat.trim());
      const lngNum = lng.trim() === "" ? null : Number(lng.trim());

      const res = await fetch(apiUrl("/api/admin/persona/branch-settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          readiness_morning_time: morning,
          readiness_afternoon_time: afternoon,
          brand_color: color.trim() || null,
          latitude: latNum,
          longitude: lngNum,
          geofence_radius_meters: radius,
          geofence_enabled: geoOn,
          clock_qr_token: qrToken.trim() || null,
          clock_qr_enabled: qrOn,
          require_service_charge: svcRequired,
          require_yesterday_closing: yClosingReq,
          require_morning_opening: mOpeningReq,
          require_today_closing: tClosingReq,
          require_daily_revenue: dailyRevReq,
          attendance_summary_time: summaryTime.trim() || null,
          shift_notify_time: shiftNotify.trim() || null,
          pending_digest_time: pendingDigest.trim() || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({
          kind: "err",
          text: j.error === "invalid_body"
            ? t("admin.persona.settings.invalidTime")
            : t("common.error")
        });
        return;
      }
      setMsg({ kind: "ok", text: t("admin.persona.settings.saved") });
      // Refresh server props so the form's "pristine" detection
      // resets to the new saved values immediately.
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally {
      setBusy(false);
    }
  }

  function resetDefaults() {
    setMorning(DEFAULT_MORNING);
    setAfternoon(DEFAULT_AFTERNOON);
  }

  // Capture admin's current GPS coordinates and pre-fill the geofence
  // centre. Convenient for setting up a new branch — open the page
  // standing at the shop, tap once, done. Falls back to a helpful
  // message when the browser denies geolocation (insecure context,
  // user previously blocked permission, etc.).
  function captureGps() {
    setGeoStatus(t("admin.persona.settings.timeClock.geofence.locating"));
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoStatus(t("admin.persona.settings.timeClock.geofence.notSupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // 5 decimal places = ~1.1m precision at the equator. More
        // than we need for a 100m geofence; chosen for visual
        // consistency without dropping into scientific notation.
        const la = pos.coords.latitude.toFixed(5);
        const lo = pos.coords.longitude.toFixed(5);
        setLat(la);
        setLng(lo);
        setGeoStatus(
          t("admin.persona.settings.timeClock.geofence.locatedAccuracy", {
            accuracy: String(Math.round(pos.coords.accuracy))
          })
        );
      },
      (err) => {
        const codeMap: Record<number, string> = {
          1: "geofence.errPermission",
          2: "geofence.errUnavailable",
          3: "geofence.errTimeout"
        };
        const key = codeMap[err.code] || "geofence.errGeneric";
        setGeoStatus(t(`admin.persona.settings.timeClock.${key}`));
      },
      // High-accuracy = use GPS hardware when available. Slower
      // (~5-10s on first call) but worth it for a one-time setup
      // that pins where staff have to physically be.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }
    );
  }

  // Mint a fresh 16-char URL-safe random token for the clock-in QR
  // poster. Admin prints + posts at the shop; staff scans on
  // clock-in. Rotating regenerates the token, invalidating any
  // previously-printed posters.
  function generateQrToken() {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    const buf = new Uint8Array(16);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(buf);
    } else {
      // Should never hit in a browser, but a Math.random() fallback
      // keeps this function from crashing in an exotic environment.
      for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
    }
    for (let i = 0; i < 16; i++) out += alphabet[buf[i] % alphabet.length];
    setQrToken(out);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="card space-y-4">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            {t("admin.persona.settings.readinessTimes.title")}
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {t("admin.persona.settings.readinessTimes.help", { branch: branchName })}
          </p>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="label">
              {t("admin.persona.settings.readinessTimes.morning")}
            </label>
            <input
              type="time"
              className="input"
              value={morning}
              onChange={(e) => setMorning(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">
              {t("admin.persona.settings.readinessTimes.afternoon")}
            </label>
            <input
              type="time"
              className="input"
              value={afternoon}
              onChange={(e) => setAfternoon(e.target.value)}
              required
            />
          </div>
        </div>
        <button
          type="button"
          onClick={resetDefaults}
          className="text-xs text-slate-500 hover:text-brand underline"
        >
          {t("admin.persona.settings.readinessTimes.reset", {
            morning: DEFAULT_MORNING,
            afternoon: DEFAULT_AFTERNOON
          })}
        </button>
      </div>

      {/* Brand colour — drives the LINE Flex header background on
          cards from this branch. Native <input type="color"> for
          the picker; we also accept hex in a sibling text input so
          admin can paste a brand-book value. Empty hex = use the
          system default (slate). */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            {t("admin.persona.settings.brandColor.title")}
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {t("admin.persona.settings.brandColor.help", { branch: branchName })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="color"
            className="w-14 h-10 border border-slate-300 rounded cursor-pointer"
            value={color || DEFAULT_BRAND_COLOR}
            onChange={(e) => setColor(e.target.value)}
          />
          <input
            type="text"
            className="input flex-1 text-sm"
            placeholder={DEFAULT_BRAND_COLOR}
            value={color}
            onChange={(e) => setColor(e.target.value)}
            maxLength={20}
          />
          <button
            type="button"
            onClick={() => setColor("")}
            className="text-xs text-slate-500 hover:text-brand underline whitespace-nowrap"
          >
            {t("admin.persona.settings.brandColor.useDefault")}
          </button>
        </div>
        {/* Live preview chip — mimics the Flex card header so admin
            sees what it'll look like before saving. */}
        <div
          className="rounded-lg p-3 text-white text-xs"
          style={{ backgroundColor: color || DEFAULT_BRAND_COLOR }}
        >
          <span className="opacity-70">IKIGAI OS · PREVIEW</span>
          <div className="font-bold mt-1">{branchName}</div>
        </div>
      </div>

      {/* ── Time Clock anti-cheat (GPS geofence + QR code) ──
          Two independent gates that the staff clock-in API enforces
          before accepting a clock-in. Off by default so existing
          deployments keep working until admin opts in. */}
      <div className="card space-y-4">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            {t("admin.persona.settings.timeClock.title")}
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {t("admin.persona.settings.timeClock.help", { branch: branchName })}
          </p>
        </div>

        {/* ── GPS geofence ── */}
        <div className="space-y-2.5 border-l-2 border-slate-200 pl-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <Switch
              checked={geoOn}
              onChange={setGeoOn}
              accent="emerald"
            />
            <span className="text-sm font-bold text-slate-800">
              {t("admin.persona.settings.timeClock.geofence.enableLabel")}
            </span>
          </label>
          <p className="text-[11px] text-slate-500">
            {t("admin.persona.settings.timeClock.geofence.help")}
          </p>
          <div className="grid sm:grid-cols-2 gap-2">
            <div>
              <label className="label text-[11px]">
                {t("admin.persona.settings.timeClock.geofence.latLabel")}
              </label>
              <input
                type="text"
                inputMode="decimal"
                className="input text-sm"
                placeholder="13.7563"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
              />
            </div>
            <div>
              <label className="label text-[11px]">
                {t("admin.persona.settings.timeClock.geofence.lngLabel")}
              </label>
              <input
                type="text"
                inputMode="decimal"
                className="input text-sm"
                placeholder="100.5018"
                value={lng}
                onChange={(e) => setLng(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={captureGps}
              className="text-xs px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 whitespace-nowrap"
            >
              📍 {t("admin.persona.settings.timeClock.geofence.useCurrent")}
            </button>
            {geoStatus && (
              <span className="text-[11px] text-slate-500 truncate">{geoStatus}</span>
            )}
          </div>
          <div>
            <label className="label text-[11px]">
              {t("admin.persona.settings.timeClock.geofence.radiusLabel")}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={10}
                max={5000}
                step={10}
                className="input w-32 text-sm"
                value={radius}
                onChange={(e) => setRadius(Number(e.target.value) || 0)}
              />
              <span className="text-xs text-slate-500">
                {t("admin.persona.settings.timeClock.geofence.radiusUnit")}
              </span>
            </div>
          </div>
        </div>

        {/* ── QR code ── */}
        <div className="space-y-2.5 border-l-2 border-slate-200 pl-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <Switch
              checked={qrOn}
              onChange={setQrOn}
              accent="emerald"
            />
            <span className="text-sm font-bold text-slate-800">
              {t("admin.persona.settings.timeClock.qr.enableLabel")}
            </span>
          </label>
          <p className="text-[11px] text-slate-500">
            {t("admin.persona.settings.timeClock.qr.help")}
          </p>
          <div>
            <label className="label text-[11px]">
              {t("admin.persona.settings.timeClock.qr.tokenLabel")}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                className="input flex-1 text-xs"
                placeholder={t("admin.persona.settings.timeClock.qr.tokenPlaceholder")}
                value={qrToken}
                onChange={(e) => setQrToken(e.target.value)}
                maxLength={64}
              />
              <button
                type="button"
                onClick={generateQrToken}
                className="text-xs px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 whitespace-nowrap"
              >
                🎲 {t("admin.persona.settings.timeClock.qr.generate")}
              </button>
            </div>
            <p className="text-[10px] text-slate-400 mt-1">
              {t("admin.persona.settings.timeClock.qr.tokenHint")}
            </p>
          </div>
        </div>
      </div>

      {/* ── Shift-close form configuration ────────────────────────
          Lightweight per-branch toggles for fields the shift_close
          staff form shows at the top (above the admin checklist).
          Currently just service-charge — closing-drawer was removed
          2026-05-23 because admin can express it as a checklist
          amount item. */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            {t("admin.persona.settings.shiftClose.title")}
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {t("admin.persona.settings.shiftClose.help", { branch: branchName })}
          </p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <Switch
            checked={svcRequired}
            onChange={setSvcRequired}
            accent="emerald"
          />
          <span className="text-sm font-bold text-slate-800">
            {t("admin.persona.settings.shiftClose.svcRequiredLabel")}
          </span>
        </label>
        <p className="text-[11px] text-slate-500">
          {t("admin.persona.settings.shiftClose.svcRequiredHint")}
        </p>

        {/* ── Required financial-amount checklists (2026-05-25) ── */}
        <div className="border-t border-slate-200 pt-3 mt-2 space-y-2">
          <h3 className="text-sm font-bold text-slate-800">
            {t("admin.persona.settings.amounts.title")}
          </h3>
          <p className="text-[11px] text-slate-500">
            {t("admin.persona.settings.amounts.help")}
          </p>
          <label className="flex items-center gap-2 cursor-pointer">
            <Switch checked={yClosingReq} onChange={setYClosingReq} accent="emerald" />
            <span className="text-sm text-slate-700">
              {t("admin.persona.settings.amounts.yesterdayClosing")}
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Switch checked={mOpeningReq} onChange={setMOpeningReq} accent="emerald" />
            <span className="text-sm text-slate-700">
              {t("admin.persona.settings.amounts.morningOpening")}
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Switch checked={tClosingReq} onChange={setTClosingReq} accent="emerald" />
            <span className="text-sm text-slate-700">
              {t("admin.persona.settings.amounts.todayClosing")}
            </span>
          </label>
          {/* require_daily_revenue (2026-05-28) — feeds branch_daily_revenue
              + appears as a headline figure on the shift_close LINE Flex
              card alongside closing/SVC. Optional even when ON — staff
              can skip and admin backfills via /admin/ascenda/revenue. */}
          <label className="flex items-center gap-2 cursor-pointer">
            <Switch checked={dailyRevReq} onChange={setDailyRevReq} accent="emerald" />
            <span className="text-sm text-slate-700">
              ยอดขายวันนี้ (ASCENDA — บนรายงาน)
            </span>
          </label>
        </div>
      </div>

      {/* ── Daily attendance summary (TC-6) ──
          One-shot roll-call sent to the executive group at the time
          configured below, splitting today's roster into 4 buckets
          (on time / late / on approved leave / absent). Empty time
          input = feature disabled for this branch. Suggested value
          is the branch's typical shift start + 1 hour. */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            {t("admin.persona.settings.attendanceSummary.title")}
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {t("admin.persona.settings.attendanceSummary.help", { branch: branchName })}
          </p>
        </div>
        <div>
          <label className="label text-[11px]">
            {t("admin.persona.settings.attendanceSummary.timeLabel")}
          </label>
          <div className="flex items-center gap-2">
            <input
              type="time"
              className="input w-36 text-sm"
              value={summaryTime}
              onChange={(e) => setSummaryTime(e.target.value)}
            />
            {summaryTime && (
              <button
                type="button"
                onClick={() => setSummaryTime("")}
                className="text-xs text-slate-500 hover:text-brand underline whitespace-nowrap"
              >
                {t("admin.persona.settings.attendanceSummary.clear")}
              </button>
            )}
          </div>
          <p className="text-[10px] text-slate-400 mt-1">
            {summaryTime
              ? t("admin.persona.settings.attendanceSummary.enabledHint", { time: summaryTime })
              : t("admin.persona.settings.attendanceSummary.disabledHint")}
          </p>
        </div>
      </div>

      <div className="card space-y-3">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            แจ้งเตือนเวรงาน (ไลน์ส่วนตัวพนักงาน)
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            ทุกเช้าระบบจะส่งข้อความเข้าไลน์ส่วนตัวของพนักงานที่มีเวรในวันนั้น
            (เวลากะ + ตำแหน่ง) สำหรับสาขา {branchName} — ต้องผูก LINE ของ
            พนักงานไว้ในข้อมูลพนักงานก่อน
          </p>
        </div>
        <div>
          <label className="label text-[11px]">เวลาส่งอัตโนมัติ (ทุกวัน)</label>
          <div className="flex items-center gap-2">
            <input
              type="time"
              className="input w-36 text-sm"
              value={shiftNotify}
              onChange={(e) => setShiftNotify(e.target.value)}
            />
            {shiftNotify && (
              <button
                type="button"
                onClick={() => setShiftNotify("")}
                className="text-xs text-slate-500 hover:text-brand underline whitespace-nowrap"
              >
                ปิดการส่งอัตโนมัติ
              </button>
            )}
          </div>
          <p className="text-[10px] text-slate-400 mt-1">
            {shiftNotify
              ? `เปิดอยู่ — ส่งทุกวันเวลา ${shiftNotify} น. (กดส่งเองได้ที่หน้าตารางมอบหมายงาน)`
              : "ปิดการส่งอัตโนมัติ — ยังกดส่งเองได้ที่หน้าตารางมอบหมายงาน"}
          </p>
        </div>
      </div>

      {/* Daily pending-requests digest (owner 2026-06-05). Sends one
          card to the executive/HR LINE group summarising staff
          requests still waiting on someone — shift-change requests +
          pending leave — so nothing falls through the cracks. */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            สรุปคำขอค้างประจำวัน (ไลน์ผู้บริหาร / HR)
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            ทุกวันระบบจะสรุปคำขอของพนักงานที่ยังรอดำเนินการ — คำขอเปลี่ยนเวลางาน
            และคำขอลางานที่รออนุมัติ — ส่งเข้ากลุ่มไลน์ผู้บริหาร / HR
            สำหรับสาขา {branchName} เพื่อไม่ให้มีคำขอตกหล่น
          </p>
        </div>
        <div>
          <label className="label text-[11px]">เวลาส่งสรุป (ทุกวัน)</label>
          <div className="flex items-center gap-2">
            <input
              type="time"
              className="input w-36 text-sm"
              value={pendingDigest}
              onChange={(e) => setPendingDigest(e.target.value)}
            />
            {pendingDigest && (
              <button
                type="button"
                onClick={() => setPendingDigest("")}
                className="text-xs text-slate-500 hover:text-brand underline whitespace-nowrap"
              >
                ปิดการส่งสรุป
              </button>
            )}
          </div>
          <p className="text-[10px] text-slate-400 mt-1">
            {pendingDigest
              ? `เปิดอยู่ — ส่งทุกวันเวลา ${pendingDigest} น. (ส่งเฉพาะวันที่มีคำขอค้าง)`
              : "ปิดอยู่ — ตั้งเวลาเพื่อให้ระบบสรุปคำขอค้างส่งเข้ากลุ่มผู้บริหารทุกวัน"}
          </p>
        </div>
      </div>

      {msg && (
        <div className={`text-sm text-center ${
          msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
        }`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}
          {msg.text}
        </div>
      )}

      <button
        type="submit"
        disabled={busy || pristine}
        className="btn-primary w-full text-base py-3.5"
      >
        {busy
          ? t("common.submitting")
          : pristine
            ? t("admin.persona.settings.pristine")
            : t("common.save")}
      </button>
    </form>
  );
}
