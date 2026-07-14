import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getSessionUser } from "@/lib/auth";
import {
  getDb,
  type Branch
} from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { pushClockInCard } from "@/lib/line";
import { getPlatformChannel, isChannelReady } from "@/lib/messaging-channels";
import {
  detectPunchAnomaly, detectScheduleDeviation, uncertifiedPriorMissingOut,
  type OwlPrompt, type DeviationPrompt
} from "@/lib/attendance-flags";
import { userHasWorkShiftOn, effectiveShiftStartForUserDate, workShiftBranchesForUserOn } from "@/lib/roster";
import { verifyClockCode } from "@/lib/clock-code";
import { saveClockSelfie } from "@/lib/clock-selfie";
import { nowBkkMinutes } from "@/lib/time";
import { mealCouponConfig, isEligibleClockIn, issueDailyCoupons } from "@/lib/meal-coupons";

const Body = z.object({
  pin: z.string().regex(/^\d{4}$/),
  // ถ้ามี entry ของ action เดียวกันที่ < 5 นาที server จะถามก่อน
  // ค่า: undefined = ครั้งแรก (server ตอบ needsReplace),
  //      true = แทนที่ด้วยเวลาปัจจุบัน,
  //      false = ใช้เวลาเดิม (no-op)
  replaceTs: z.boolean().optional(),
  // Anti-cheat (TC-2): GPS + QR. Both optional in the body — the
  // server checks branch.geofence_enabled / branch.clock_qr_enabled
  // to decide whether to require them. Sending them when disabled is
  // harmless (we just ignore).
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  // gpsAccuracy is the navigator.geolocation-reported accuracy in
  // metres. We don't reject based on it here, but we widen the
  // geofence by this much so a high-accuracy reading isn't rejected
  // by a strict boundary while a low-accuracy one still has to be
  // clearly inside.
  gpsAccuracy: z.number().min(0).max(10000).optional(),
  qrToken: z.string().max(64).optional(),
  // Selfie captured at clock-in as a base64 data-URL (owner 2026-07-14) — only
  // required when the branch has clock_selfie_enabled. Cap the string generously;
  // saveClockSelfie enforces the real decoded-byte limit + jpeg/webp type.
  selfie: z.string().max(2_000_000).optional(),
  // Explicit clock direction from the split เข้า/ออก buttons (owner
  // 2026-06-09). When omitted, the server auto-decides (back-compat).
  intent: z.enum(["in", "out"]).optional()
});

const FIVE_MIN_MS = 5 * 60 * 1000;

// Great-circle distance between two lat/lng points, in metres.
// Standard Haversine formula. Earth radius averaged as 6371 km.
function haversineMeters(
  lat1: number, lng1: number, lat2: number, lng2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000; // metres
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const rl = rateLimit(`clock:${user.id}`, 8, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterSec: Math.ceil(rl.retryAfterMs / 1000) },
      { status: 429 }
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_pin_format" }, { status: 400 });
  }

  // The clock-in row is tagged with the staff's currently-selected
  // branch (set via /staff/branch-picker). Without an active branch
  // we can't attribute the entry — payroll-by-branch would be wrong.
  // Staff with 0 branches assigned hits this path; admin must fix
  // their assignments before they can clock in.
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }

  const db = getDb();
  const row = db.prepare("SELECT pin_hash FROM users WHERE id = ?").get(user.id) as
    | { pin_hash: string | null } | undefined;

  if (!row?.pin_hash) {
    return NextResponse.json({ error: "no_pin_set" }, { status: 400 });
  }
  if (!bcrypt.compareSync(parsed.data.pin, row.pin_hash)) {
    return NextResponse.json({ error: "wrong_pin" }, { status: 401 });
  }

  // ── Effective clock branch (owner 2026-07-14) ──────────────────
  // A cross-branch rotator shouldn't have to manually switch their active
  // branch before clocking in at the other site. Resolve the branch this
  // punch attributes to from TODAY's roster: if the active branch has a work
  // shift today keep it; else if exactly one OTHER branch is rostered today,
  // auto-pick that; else fall back to the active branch (the no-shift guard
  // below then produces the right "no shift" error). Everything downstream
  // (geofence, per-branch clock state, no-shift guard, the punch's branch_id,
  // meal-coupon + deviation) uses this resolved branch so the whole flow is
  // consistent — including geofence validating against the site they're at.
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rosterBranchesToday = workShiftBranchesForUserOn(user.id, todayBkk);
  const clockBranchId =
    rosterBranchesToday.includes(user.activeBranchId) ? user.activeBranchId
    : rosterBranchesToday.length === 1 ? rosterBranchesToday[0]
    : user.activeBranchId;

  // ── Anti-cheat (TC-2): GPS geofence + QR code ──────────────────
  // Fetch the branch row once here — same row drives both checks
  // and is then handed off to the LINE notify path further down.
  // Both gates are admin-toggleable (branches.geofence_enabled /
  // clock_qr_enabled); when off, we skip the corresponding check
  // entirely so existing deployments keep working.
  const branchRow = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(clockBranchId) as Branch | undefined;
  if (!branchRow) {
    return NextResponse.json({ error: "branch_not_found" }, { status: 404 });
  }

  // Rotating-QR mode (branches.clock_totp_secret set) forces GPS on too, so a
  // scanned code alone can't be used from home (owner 2026-07-14) — GPS is the
  // real location proof, the rotating code is the anti-share + scan layer.
  const rotatingQr = branchRow.clock_totp_secret != null;
  const selfieRequired = branchRow.clock_selfie_enabled === 1;
  // Selfie proves WHO, GPS proves WHERE — require both together so a selfie
  // taken from home (with a faked location) still can't punch.
  const geofenceRequired = branchRow.geofence_enabled === 1 || rotatingQr || selfieRequired;

  if (geofenceRequired) {
    if (parsed.data.lat == null || parsed.data.lng == null) {
      return NextResponse.json({ error: "gps_required" }, { status: 400 });
    }
    if (branchRow.latitude == null || branchRow.longitude == null) {
      // Geofence enabled but admin hasn't set a centre — fail closed
      // rather than silently accepting any location, so this misconfig
      // surfaces immediately instead of being mistaken for a working
      // anti-cheat.
      return NextResponse.json(
        { error: "geofence_misconfigured" },
        { status: 500 }
      );
    }
    const distance = haversineMeters(
      parsed.data.lat, parsed.data.lng,
      branchRow.latitude, branchRow.longitude
    );
    // Effective radius = configured radius + GPS-reported accuracy.
    // A phone reporting ±25m on a 100m geofence has up to 125m of
    // "could be inside" margin — we accept that rather than reject
    // a genuine on-site reading whose accuracy happens to be poor
    // (e.g., indoors, near tall buildings). Cheating from home gives
    // distances in kilometres so the margin doesn't open meaningful
    // attack surface.
    const effectiveRadius =
      branchRow.geofence_radius_meters + (parsed.data.gpsAccuracy ?? 0);
    if (distance > effectiveRadius) {
      return NextResponse.json(
        {
          error: "out_of_geofence",
          distanceMeters: Math.round(distance),
          allowedMeters: branchRow.geofence_radius_meters
        },
        { status: 403 }
      );
    }
  }

  if (rotatingQr) {
    // Rotating QR — the scanned value is a time-based HMAC code (carried in the
    // existing qrToken field). Valid only for the current 30s window ±1, so a
    // photographed poster is useless within a minute.
    if (!parsed.data.qrToken) {
      return NextResponse.json({ error: "qr_required" }, { status: 400 });
    }
    if (!verifyClockCode(branchRow.clock_totp_secret!, parsed.data.qrToken, Date.now())) {
      return NextResponse.json({ error: "qr_expired" }, { status: 403 });
    }
  } else if (branchRow.clock_qr_enabled === 1) {
    // Legacy static QR — an admin-set constant token printed as a poster.
    if (!parsed.data.qrToken) {
      return NextResponse.json({ error: "qr_required" }, { status: 400 });
    }
    if (!branchRow.clock_qr_token) {
      // QR enabled but admin hasn't set a token — same fail-closed
      // logic as the geofence misconfig case above.
      return NextResponse.json(
        { error: "qr_misconfigured" },
        { status: 500 }
      );
    }
    if (parsed.data.qrToken !== branchRow.clock_qr_token) {
      return NextResponse.json({ error: "invalid_qr_token" }, { status: 403 });
    }
  }

  // คำนวณช่วงวันนี้ (Bangkok local) — todayBkk computed above for branch resolve.
  const startIso = new Date(`${todayBkk}T00:00:00+07:00`).toISOString();
  const endIso = new Date(`${todayBkk}T23:59:59+07:00`).toISOString();

  // Per-branch clock state (owner 2026-06-09): only count punches at the
  // resolved clock branch, so a two-branch staff clocks in/out independently at
  // each (clocking out pairs with THIS branch's in, not the other branch's).
  const todays = db.prepare(`
    SELECT id, type, ts FROM time_entries
    WHERE user_id = ? AND branch_id = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(user.id, clockBranchId, startIso, endIso) as Array<{ id: number; type: "in" | "out"; ts: string }>;

  const firstIn = todays.find((e) => e.type === "in") ?? null;
  const firstOut = todays.find((e) => e.type === "out") ?? null;

  const nowMs = Date.now();
  const nowIso = new Date().toISOString();
  const inAge = firstIn ? nowMs - new Date(firstIn.ts).getTime() : Infinity;
  const outAge = firstOut ? nowMs - new Date(firstOut.ts).getTime() : Infinity;

  // ตัดสินใจ action + ตรวจ correction window
  let action: "in" | "out";
  let existing: { id: number; ts: string } | null = null;
  const intent = parsed.data.intent;

  if (intent === "out") {
    // Explicit clock-OUT (split buttons). Cannot clock out without a
    // clock-in today — this is the root fix for "ลืมกดเข้า แล้วกดออก
    // กลายเป็นเวลาเข้า" (owner 2026-06-09). Staff must certify the missing
    // clock-in first.
    if (!firstIn) {
      return NextResponse.json({ error: "no_clock_in_today" }, { status: 409 });
    }
    if (firstOut) {
      if (outAge < FIVE_MIN_MS) { action = "out"; existing = { id: firstOut.id, ts: firstOut.ts }; }
      else return NextResponse.json({ error: "already_done_today" }, { status: 409 });
    } else {
      action = "out";
    }
  } else if (intent === "in") {
    // Explicit clock-IN. If already clocked in earlier today (outside the
    // 5-min self-fix), refuse rather than silently flipping to an OUT.
    if (firstIn) {
      if (inAge < FIVE_MIN_MS) { action = "in"; existing = { id: firstIn.id, ts: firstIn.ts }; }
      else return NextResponse.json({ error: "already_clocked_in" }, { status: 409 });
    } else {
      action = "in";
    }
  } else if (!firstIn) {
    // ── Legacy auto-decide (no intent sent) ──
    action = "in";
  } else if (!firstOut) {
    if (inAge < FIVE_MIN_MS) {
      // ยังอยู่ใน 5 นาทีของ "in" → ถามว่าจะแก้ไหม
      action = "in";
      existing = { id: firstIn.id, ts: firstIn.ts };
    } else {
      action = "out";
    }
  } else {
    if (outAge < FIVE_MIN_MS) {
      action = "out";
      existing = { id: firstOut.id, ts: firstOut.ts };
    } else {
      // นอกหน้าต่าง 5 นาทีของ "out" → ครบแล้ว ติดต่อหัวหน้างาน
      return NextResponse.json({ error: "already_done_today" }, { status: 409 });
    }
  }

  // ── No-shift guard (owner 2026-06-13) ──────────────────────────
  // Block a fresh clock-IN when the user has no WORK shift rostered today
  // (no assignment, or a day-off). Applies to everyone (staff + admin).
  // Only gates a brand-new clock-in — clock-out and the 5-min self-correction
  // (existing != null) pass through so someone already at work can finish.
  if (action === "in" && !existing) {
    if (!userHasWorkShiftOn(user.id, clockBranchId, todayBkk)) {
      const sup = db.prepare(`
        SELECT m.display_name AS name
        FROM users u JOIN users m ON m.id = u.reports_to_user_id
        WHERE u.id = ?
      `).get(user.id) as { name: string | null } | undefined;
      return NextResponse.json(
        { error: "no_shift_today", supervisorName: sup?.name ?? null },
        { status: 403 }
      );
    }

    // ── Prior-day missing clock-out guard (owner 2026-06-14, #9 part B) ──
    // If the most recent prior working day has an "in" with no "out" and the
    // staff hasn't filed a certification for it yet, block today's clock-in —
    // they must certify yesterday first (which auto-records a discipline note,
    // see the time-certification route). Once the cert is FILED the day is no
    // longer uncertified → unblocked immediately, no admin approval needed
    // (owner: "ปลดบล็อกก่อน"). Scoped to a fresh clock-in so nobody mid-shift
    // gets stranded. Supersedes the earlier pending-cert block.
    const danglingDay = uncertifiedPriorMissingOut(
      user.id, clockBranchId, todayBkk
    );
    if (danglingDay) {
      return NextResponse.json(
        { error: "prior_day_missing_out", workDate: danglingDay },
        { status: 409 }
      );
    }
  }

  // กัน race: ถ้า client ส่ง replaceTs มา แต่ server ตอนนี้ไม่เห็น existing
  // (อาจเพราะหน้าต่าง 5 นาทีหมดอายุระหว่างที่ user เลือก) → reject ไม่ INSERT มั่ว
  if (parsed.data.replaceTs !== undefined && !existing) {
    return NextResponse.json(
      { error: "correction_window_expired" },
      { status: 409 }
    );
  }

  if (existing) {
    // ครั้งแรก: ยังไม่ส่ง replaceTs → ถาม client
    if (parsed.data.replaceTs === undefined) {
      return NextResponse.json({
        needsReplace: true,
        action,
        existingTs: existing.ts,
        proposedTs: nowIso
      });
    }

    // เลือก "เปลี่ยนเป็นเวลาปัจจุบัน"
    if (parsed.data.replaceTs === true) {
      const tx = db.transaction(() => {
        // audit: บันทึก self-correction
        db.prepare(`
          INSERT INTO time_entries_audit
            (entry_id, entry_user_id, entry_type, entry_ts, action, admin_id, reason, created_at)
          VALUES (?, ?, ?, ?, 'edit', ?, ?, ?)
        `).run(existing!.id, user.id, action, existing!.ts, user.id, "self-correction (5min window)", nowIso);
        db.prepare("UPDATE time_entries SET ts = ? WHERE id = ?").run(nowIso, existing!.id);
      });
      tx();
      return NextResponse.json({ ok: true, action, replaced: true });
    }

    // เลือก "ใช้เวลาเดิม" → ไม่ทำอะไร
    return NextResponse.json({ ok: true, action, replaced: false });
  }

  // Selfie (owner 2026-07-14) — required when the branch enables it. Saved here
  // (just before the INSERT) so a request that failed an earlier guard
  // (no_shift_today / prior_day_missing_out) never leaves an orphan file. Only
  // fresh punches carry a selfie; the 5-min self-correction path above keeps the
  // original row + its selfie.
  let selfiePath: string | null = null;
  if (selfieRequired) {
    if (!parsed.data.selfie) {
      return NextResponse.json({ error: "selfie_required" }, { status: 400 });
    }
    const saved = saveClockSelfie(user.id, parsed.data.selfie);
    if (!saved.ok) {
      return NextResponse.json({ error: saved.error }, { status: 400 });
    }
    selfiePath = saved.filename;
  }

  // ไม่มี existing → INSERT ใหม่ตามปกติ
  // branch_id = the resolved clock branch (roster-aware) so payroll/timesheets
  // attribute hours to the branch actually worked today, even for a rotator
  // who didn't switch their active branch (owner 2026-07-14).
  db.prepare("INSERT INTO time_entries (user_id, type, ts, branch_id, selfie_path) VALUES (?, ?, ?, ?, ?)")
    .run(user.id, action, nowIso, clockBranchId, selfiePath);

  // ── น้องฮูก: forgot-to-punch detection (owner 2026-06-08) ──────────
  // STRICTLY ADVISORY — the punch above already committed. This only
  // records a soft history flag + returns a prompt to nudge the staff to
  // certify the missing punch. Wrapped so a detection bug can NEVER break
  // a clock-in (the CLAUDE.md morning-window rule).
  let owl: OwlPrompt | null = null;
  try {
    owl = detectPunchAnomaly({
      userId: user.id,
      branchId: clockBranchId,
      action,
      todayBkk
    });
  } catch (e) {
    console.warn("[clock] attendance anomaly detection failed:", e);
  }
  // Don't re-nudge to certify a missing punch the staff already filed a cert
  // for (owner 2026-06-14) — avoids a redundant owl right after they certified
  // yesterday's missing clock-out and got unblocked.
  if (owl) {
    const certed = db.prepare(`
      SELECT 1 FROM time_certifications
      WHERE requested_by = ? AND kind = 'missing' AND entry_type = ?
        AND work_date = ? AND status IN ('pending', 'approved')
      LIMIT 1
    `).get(user.id, owl.kind === "missing_out" ? "out" : "in", owl.work_date);
    if (certed) owl = null;
  }

  // Schedule-deviation (late/early vs roster → maybe a shift swap). Only
  // on a fresh clock-IN, and only when no missing-punch nudge already
  // fired (one prompt per punch). Advisory — never blocks the clock-in.
  let swap: DeviationPrompt | null = null;
  if (action === "in" && !owl) {
    try {
      swap = detectScheduleDeviation({
        userId: user.id,
        branchId: clockBranchId,
        todayBkk,
        actualIso: nowIso
      });
    } catch (e) {
      console.warn("[clock] schedule deviation detection failed:", e);
    }
  }

  // ── Meal coupon (owner 2026-07-12) ─────────────────────────────────
  // A fresh clock-IN to the eligible lunch shift (11:00/12:00, not too
  // late) issues a lunch + drink coupon, shown as a pop-up. Idempotent
  // per (user, date). Wrapped so a bug here can NEVER break the clock-in.
  let coupon: { food: boolean; drink: boolean; redeemBefore: string } | null = null;
  if (action === "in" && clockBranchId) {
    try {
      const cfg = mealCouponConfig(clockBranchId);
      if (cfg.enabled) {
        const shiftStart = effectiveShiftStartForUserDate(user.id, clockBranchId, todayBkk);
        if (isEligibleClockIn(cfg, shiftStart, nowBkkMinutes().minutes)) {
          coupon = issueDailyCoupons(user.id, clockBranchId, todayBkk);
        }
      }
    } catch (e) {
      console.warn("[clock] meal coupon issue failed:", e);
    }
  }

  // ── Fire-and-forget: ส่ง LINE flex confirmation message on clock-in ──
  // Channel: IKIGAI OS (platform-level OA, shared across all branches).
  // Branch context: ใช้แค่ดึงเวลาพักกลางวัน + ชื่อสาขามาแสดงในข้อความ.
  // ถ้าระบบยังไม่ได้ตั้ง platform OA หรือพนักงานยังไม่ได้ bind LINE userId
  // → เงียบ ไม่ error ไม่ block response ของ clock-in.
  if (action === "in" && clockBranchId) {
    const platform = getPlatformChannel();
    if (isChannelReady(platform)) {
      // Re-use the branchRow already fetched at the anti-cheat
      // gate above — saves a redundant SELECT.
      const branch = branchRow;
      if (branch) {
        // Build the PERSONA deep link from the request — works on any host
        // (production or local) without depending on a possibly-stale env var.
        const proto = req.headers.get("x-forwarded-proto") ?? "https";
        const host = req.headers.get("host") ?? "ikigaimedihealth.com";
        const personaUrl = `${proto}://${host}/staff/persona`;

        void pushClockInCard({
          userId: user.id,
          displayName: user.display_name,
          branch,
          platformChannelToken: platform!.channel_token!,
          personaUrl,
          clockInIsoTs: nowIso
        }).catch(() => { /* swallow — never block clock-in */ });
      }
    }
  }

  // Note: the per-clock-event group "who's in / who's not" Flex was
  // removed in TC-6. The personal pushClockInCard above still gives
  // each staff their own confirmation. Executive group now receives
  // one consolidated 4-category roll-call per day at the configured
  // attendance_summary_time, fired from /api/cron — see
  // src/lib/daily-attendance-summary.ts.

  return NextResponse.json({
    ok: true,
    action,
    ...(owl ? { owl } : {}),
    ...(swap ? { swap } : {}),
    ...(coupon ? { coupon } : {})
  });
}
