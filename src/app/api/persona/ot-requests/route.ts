import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { notifyToStaffGroup } from "@/lib/line";
import { nameWithPrefix } from "@/lib/name";

// POST /api/persona/ot-requests — a staff member records that they had
// pre-approved OT for a day (entered at clock-out when น้องฮูก asks).
// Creates a PENDING request; a supervisor/admin must approve before it
// counts toward pay. One request per (user, day) — re-submitting updates
// it back to pending.

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const Body = z.object({
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requested_until: z.string().regex(HHMM)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { work_date, requested_until } = parsed.data;
  const branchId = user.activeBranchId ?? null;
  const db = getDb();

  db.prepare(`
    INSERT INTO ot_requests (user_id, branch_id, work_date, requested_until, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
    ON CONFLICT (user_id, work_date) DO UPDATE SET
      requested_until = excluded.requested_until,
      branch_id = excluded.branch_id,
      status = 'pending',
      decided_by = NULL,
      decided_at = NULL
  `).run(user.id, branchId, work_date, requested_until, new Date().toISOString());

  // Notify the staff group so a supervisor can approve. Fire-and-forget.
  try {
    const branch = branchId != null
      ? (db.prepare("SELECT * FROM branches WHERE id = ?").get(branchId) as Branch | undefined)
      : undefined;
    if (branch) {
      const flex = {
        type: "flex" as const,
        altText: `ขออนุมัติทำงานล่วงเวลา · ${nameWithPrefix(user.title_prefix, user.display_name)} · ${work_date}`,
        contents: {
          type: "bubble" as const, size: "kilo",
          header: {
            type: "box", layout: "vertical", paddingAll: "16px", backgroundColor: "#1a1a2e",
            contents: [
              { type: "text", text: "PERSONA · คำขอทำงานล่วงเวลา", size: "xxs", color: "#fda4af", weight: "bold" },
              { type: "text", text: "รออนุมัติการทำงานล่วงเวลา", size: "md", color: "#ffffff", weight: "bold", margin: "xs" }
            ]
          },
          body: {
            type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px",
            contents: [
              { type: "text", text: nameWithPrefix(user.title_prefix, user.display_name), weight: "bold", size: "sm", color: "#1a1a2e" },
              { type: "text", text: `${branch.name} · วันที่ ${work_date}`, size: "xs", color: "#888888", margin: "xs" },
              { type: "text", text: `ขอทำงานล่วงเวลาถึง ${requested_until} น.`, size: "sm", color: "#333333", margin: "md" }
            ]
          },
          footer: {
            type: "box", layout: "vertical", paddingAll: "16px",
            contents: [
              { type: "button", style: "primary", color: "#a06820",
                action: { type: "uri", label: "ตรวจสอบ/อนุมัติ", uri: `${PUBLIC_BASE}/admin/persona/ot-approvals` } }
            ]
          }
        }
      };
      void notifyToStaffGroup(branch, flex, "global").catch(() => {});
    }
  } catch {
    /* never block the request */
  }

  return NextResponse.json({ ok: true });
}
