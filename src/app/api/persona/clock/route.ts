import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getSessionUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { pushClockInCard } from "@/lib/line";
import { getPlatformChannel, isChannelReady } from "@/lib/messaging-channels";

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
  qrToken: z.string().max(64).optional()
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

  // ── Anti-cheat (TC-2): GPS geofence + QR code ──────────────────
  // Fetch the branch row once here — same row drives both checks
  // and is then handed off to the LINE notify path further down.
  // Both gates are admin-toggleable (branches.geofence_enabled /
  // clock_qr_enabled); when off, we skip the corresponding check
  // entirely so existing deployments keep working.
  const branchRow = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branchRow) {
    return NextResponse.json({ error: "branch_not_found" }, { status: 404 });
  }

  if (branchRow.geofence_enabled === 1) {
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

  if (branchRow.clock_qr_enabled === 1) {
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

  // คำนวณช่วงวันนี้ (Bangkok local)
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const startIso = new Date(`${todayBkk}T00:00:00+07:00`).toISOString();
  const endIso = new Date(`${todayBkk}T23:59:59+07:00`).toISOString();

  const todays = db.prepare(`
    SELECT id, type, ts FROM time_entries
    WHERE user_id = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(user.id, startIso, endIso) as Array<{ id: number; type: "in" | "out"; ts: string }>;

  const firstIn = todays.find((e) => e.type === "in") ?? null;
  const firstOut = todays.find((e) => e.type === "out") ?? null;

  const nowMs = Date.now();
  const nowIso = new Date().toISOString();
  const inAge = firstIn ? nowMs - new Date(firstIn.ts).getTime() : Infinity;
  const outAge = firstOut ? nowMs - new Date(firstOut.ts).getTime() : Infinity;

  // ตัดสินใจ action + ตรวจ correction window
  let action: "in" | "out";
  let existing: { id: number; ts: string } | null = null;

  if (!firstIn) {
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

  // ไม่มี existing → INSERT ใหม่ตามปกติ
  // branch_id captured from session activeBranchId so payroll/timesheets
  // can attribute hours to the correct branch (Phase 2, 2026-05).
  db.prepare("INSERT INTO time_entries (user_id, type, ts, branch_id) VALUES (?, ?, ?, ?)")
    .run(user.id, action, nowIso, user.activeBranchId);

  // ── Fire-and-forget: ส่ง LINE flex confirmation message on clock-in ──
  // Channel: IKIGAI OS (platform-level OA, shared across all branches).
  // Branch context: ใช้แค่ดึงเวลาพักกลางวัน + ชื่อสาขามาแสดงในข้อความ.
  // ถ้าระบบยังไม่ได้ตั้ง platform OA หรือพนักงานยังไม่ได้ bind LINE userId
  // → เงียบ ไม่ error ไม่ block response ของ clock-in.
  if (action === "in" && user.activeBranchId) {
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

  return NextResponse.json({ ok: true, action });
}
