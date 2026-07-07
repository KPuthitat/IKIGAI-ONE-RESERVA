import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, getSystemSettings, type Branch } from "@/lib/db";
import { getPlatformChannel, isChannelReady } from "@/lib/messaging-channels";
import {
  sendLinePush,
  personaShiftReminderFlex,
  personaClockInFlex,
  dailyAttendanceSummaryFlex,
  notifyToStaffGroup
} from "@/lib/line";

// POST /api/admin/persona/test-notification
//
// Fires a sample notification of `kind` so admin can preview the LINE
// Flex layout / copy on their own device. Most kinds go to the calling
// admin's personal LINE userId (must be bound in their employee row).
// Group-targeted kinds (e.g. attendance summary) go to the executive
// group via notifyToStaffGroup.
//
// This is a developer/QA surface; we don't write to any "real" tables
// — no daily_reports row, no roster_assignment, no audit. Pure push.
// The mock data is built inline so admin can re-fire as often as they
// like without polluting production state.

const Body = z.object({
  kind: z.enum([
    "shift_work",
    "shift_day_off",
    "shift_on_leave",
    "clock_in",
    "attendance_summary"
  ])
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { kind } = parsed.data;

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

  // Resolve the calling admin's own LINE userId + display info — most
  // cards push DM to the caller so they can verify on their own phone.
  // Pull nickname + prefix too so the DM cards greet by real name
  // (e.g. "สวัสดีครับ พี่ภู") instead of the generic "พี่ฮูก" placeholder.
  // PDPA-safe because these cards never leave the caller's own LINE.
  const me = db.prepare(`
    SELECT line_user_id, display_name, nickname_th, title_prefix
    FROM users WHERE id = ?
  `).get(user.id) as {
    line_user_id: string | null;
    display_name: string;
    nickname_th: string | null;
    title_prefix: string | null;
  } | undefined;

  const platform = getPlatformChannel();
  if (!isChannelReady(platform) || !platform?.channel_token) {
    return NextResponse.json({
      error: "platform_channel_not_ready",
      message: "ตั้งค่า IKIGAI OS LINE OA token + secret ที่ /admin/persona/messaging ก่อน"
    }, { status: 412 });
  }
  const platformToken = platform.channel_token;

  // Bangkok-local today + display values for mock cards
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const friendlyDate = (() => {
    const [yStr, mStr, dStr] = todayBkk.split("-");
    const y = Number(yStr), m = Number(mStr), d = Number(dStr);
    // UTC-midnight + getUTCDay so the weekday name matches the day number on a
    // UTC server (the +07:00/getDay combo rolled back a day — owner 2026-07-06).
    const wd = new Date(`${todayBkk}T00:00:00Z`).getUTCDay();
    const WD = ["วันอาทิตย์","วันจันทร์","วันอังคาร","วันพุธ","วันพฤหัสบดี","วันศุกร์","วันเสาร์"];
    const MO = ["", "มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
                "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
    return `${WD[wd]}ที่ ${d} ${MO[m]} ${y + 543}`;
  })();

  // Helper: DM push to caller, with a friendly error when their LINE
  // isn't bound (most common cause of "I clicked but nothing came").
  async function pushToMe(flex: ReturnType<typeof personaShiftReminderFlex>) {
    if (!me?.line_user_id) {
      return NextResponse.json({
        error: "no_line_bound",
        message: "บัญชี admin ของคุณยังไม่ได้เชื่อมต่อ LINE — เชื่อมต่อที่หน้า /staff/persona/profile ก่อน"
      }, { status: 412 });
    }
    const res = await sendLinePush(platformToken, {
      to: me.line_user_id,
      messages: [flex]
    });
    if (!res.ok) {
      return NextResponse.json({
        error: "push_failed",
        detail: res.error
      }, { status: 502 });
    }
    return NextResponse.json({ ok: true, sent_to: "self_dm" });
  }

  // PDPA — the attendance_summary kind goes to the EXECUTIVE GROUP,
  // so its mock rows always use placeholder names (no real staff data
  // leaks to a group chat). The shift / clock-in kinds DM the caller
  // only — they can safely use the caller's own name + nickname so
  // the preview feels like a real notification on their phone.
  const MOCK_NAME = me?.display_name || "พนักงานทดสอบ";
  const MOCK_PREFIX: string | null = me?.title_prefix ?? null;
  // 2026-05-27: empty fallback is fine — the greeting picker handles
  // a blank nickname by stripping the {NAME} placeholder cleanly so
  // the line reads "สวัสดีครับพี่ น้องฮูกแวะมาทักทาย" instead of the
  // old double-พี่ glitch ("สวัสดีครับพี่พี่ฮูก ...").
  const MOCK_NICKNAME = me?.nickname_th?.trim() || "";

  // Pass the admin's saved greeting overrides through so the test
  // card reflects exactly what staff will see. The shape mirrors what
  // sendShiftNotifications builds — null on a kind means "use default
  // pool" inside pickShiftGreeting.
  const ss = getSystemSettings();
  const greetingOverrides = {
    work: ss.shift_greetings_work,
    day_off: ss.shift_greetings_day_off,
    on_leave: ss.shift_greetings_on_leave
  };

  try {
    switch (kind) {
      case "shift_work":
        return await pushToMe(personaShiftReminderFlex({
          branchName: branch.name,
          dateLabel: friendlyDate,
          displayName: MOCK_NAME,
          titlePrefix: MOCK_PREFIX,
          nickname: MOCK_NICKNAME,
          kind: "work",
          // Sample shift mirrors the real roster shape — title in the
          // green banner, code on the row below, free-text description
          // below that. Mock uses one of the seeded positions
          // ("PASTA") so admin sees the actual layout, not a generic
          // "บาริสต้า" placeholder.
          shifts: [{
            positionTitle: "PASTA",
            positionDescription: "ดูแลและผลิตเส้นตามที่ได้รับมอบหมาย รวมถึงดูแลความสะอาดของพื้นที่ทำงาน",
            shiftCode: "NPF",
            start: "08:00",
            end: "16:00"
          }],
          leaveTypeLabel: null,
          headerColor: branch.brand_color,
          dateBkk: todayBkk,
          greetingOverrides
        }));

      case "shift_day_off":
        return await pushToMe(personaShiftReminderFlex({
          branchName: branch.name,
          dateLabel: friendlyDate,
          displayName: MOCK_NAME,
          titlePrefix: MOCK_PREFIX,
          nickname: MOCK_NICKNAME,
          kind: "day_off",
          shifts: [],
          leaveTypeLabel: null,
          headerColor: branch.brand_color,
          dateBkk: todayBkk,
          greetingOverrides
        }));

      case "shift_on_leave":
        return await pushToMe(personaShiftReminderFlex({
          branchName: branch.name,
          dateLabel: friendlyDate,
          displayName: MOCK_NAME,
          titlePrefix: MOCK_PREFIX,
          nickname: MOCK_NICKNAME,
          kind: "on_leave",
          shifts: [],
          leaveTypeLabel: "ลาป่วย",
          headerColor: branch.brand_color,
          dateBkk: todayBkk,
          greetingOverrides
        }));

      case "clock_in": {
        const nowIso = new Date().toISOString();
        const clockFlex = personaClockInFlex({
          displayName: MOCK_NAME,
          clockInIsoTs: nowIso,
          branchName: branch.name,
          lunchStart: branch.lunch_break_start ?? "12:00",
          lunchEnd: branch.lunch_break_end ?? "13:00",
          hasLunchToday: true,
          personaUrl: "https://ikigaimedihealth.com/staff/persona",
          headerColor: branch.brand_color
        });
        return await pushToMe(clockFlex);
      }

      case "attendance_summary": {
        // All 5 rows use placeholder names so the executive group
        // never sees real staff data on a test fire.
        const mock = dailyAttendanceSummaryFlex({
          branchName: branch.name,
          reportDate: todayBkk,
          rows: [
            { displayName: "ทดสอบ ตรงเวลา", titlePrefix: null,
              category: "on_time", inTs: new Date().toISOString(),
              minutesLate: 0, leaveType: null },
            { displayName: "ทดสอบ มาสาย", titlePrefix: null,
              category: "late", inTs: new Date().toISOString(),
              minutesLate: 12, leaveType: null },
            { displayName: "ทดสอบ ลางาน", titlePrefix: null,
              category: "on_leave", inTs: null,
              minutesLate: 0, leaveType: "sick" },
            { displayName: "ทดสอบ รอ", titlePrefix: null,
              category: "not_yet", inTs: null,
              minutesLate: 0, leaveType: null },
            { displayName: "ทดสอบ ขาด", titlePrefix: null,
              category: "absent", inTs: null,
              minutesLate: 0, leaveType: null }
          ],
          headerColor: branch.brand_color
        });
        // Goes to the executive group (same channel as the real
        // summary). notifyToStaffGroup throws on push failure.
        try {
          await notifyToStaffGroup(branch, mock, "global");
        } catch (e) {
          return NextResponse.json({
            error: "group_push_failed",
            detail: e instanceof Error ? e.message : String(e)
          }, { status: 502 });
        }
        return NextResponse.json({ ok: true, sent_to: "executive_group" });
      }
    }
  } catch (e) {
    return NextResponse.json({
      error: "exception",
      detail: e instanceof Error ? e.message : String(e)
    }, { status: 500 });
  }
}
