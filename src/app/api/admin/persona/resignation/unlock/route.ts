import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, getSystemSettings } from "@/lib/db";
import { getPlatformChannel, isChannelReady } from "@/lib/messaging-channels";
import {
  sendLinePush,
  personaResignationUnlockedFlex,
  renderResignationUnlockBody
} from "@/lib/line";

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");

const Body = z.object({
  user_id: z.number().int().positive(),
  action: z.enum(["unlock", "lock"])
});

// POST /api/admin/persona/resignation/unlock
// admin เปิด/ปิดสิทธิ์การยื่นลาออกให้พนักงาน
export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  // Pull display fields too so we can build the Flex card without a
  // second query.
  const target = db.prepare(
    "SELECT id, display_name, nickname_th, line_user_id FROM users WHERE id = ?"
  ).get(parsed.data.user_id) as {
    id: number;
    display_name: string;
    nickname_th: string | null;
    line_user_id: string | null;
  } | undefined;
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

  if (parsed.data.action === "unlock") {
    const nowIso = new Date().toISOString();
    db.prepare(
      "UPDATE users SET resignation_unlocked_at = ?, resignation_unlocked_by = ? WHERE id = ?"
    ).run(nowIso, user.id, parsed.data.user_id);

    // Owl notification — 2026-05-27. DM the staff so they know the
    // gate just opened. Body text is owner-authored at /admin/system
    // -settings (resignation_unlock_message column) with `{ADMIN}`
    // substituted to the operator's display_name; NULL/empty falls
    // back to the built-in default. Fire-and-forget: a LINE hiccup
    // must not roll back the DB write. Silent skip when no LINE
    // binding or no platform OA.
    if (target.line_user_id?.trim()) {
      const platform = getPlatformChannel();
      if (isChannelReady(platform) && platform?.channel_token) {
        const recipientName = (target.nickname_th?.trim() || target.display_name || "").trim();
        const customMessage = getSystemSettings().resignation_unlock_message;
        const bodyMessage = renderResignationUnlockBody(customMessage, user.display_name);
        const flex = personaResignationUnlockedFlex({
          recipientName,
          unlockedByName: user.display_name,
          bodyMessage,
          resignationUrl: `${PUBLIC_BASE}/staff/persona/resignation`,
          headerColor: null
        });
        sendLinePush(platform.channel_token, {
          to: target.line_user_id,
          messages: [flex]
        }).catch((e) => console.warn("resignation-unlock LINE push failed", e));
      }
    }
  } else {
    db.prepare(
      "UPDATE users SET resignation_unlocked_at = NULL, resignation_unlocked_by = NULL WHERE id = ?"
    ).run(parsed.data.user_id);
  }

  return NextResponse.json({ ok: true });
}
