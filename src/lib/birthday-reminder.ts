// Birthday heads-up for the HR group (owner 2026-10-10): 3, 2 and 1 day before a
// colleague's birthday, one card a day listing who is coming up. Day + month of the
// stored dob decide it (the year may be CE or BE), so no age is ever shown.

import { getDb } from "./db";
import { nameWithPrefix } from "./name";
import { formatMonthDay } from "./time";
import type { LineFlexMessage } from "./line";

export const BIRTHDAY_LEAD_DAYS = [3, 2, 1] as const;

export type BirthdayPerson = { userId: number; name: string; nickname: string | null; branches: string[]; date: string; daysAhead: number };

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Active staff whose birthday falls exactly 3, 2 or 1 day after `todayIso`. A 29 Feb
 *  birthday is celebrated on 28 Feb in a year without one. */
export function upcomingBirthdays(todayIso: string): BirthdayPerson[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT u.id, u.display_name, u.title_prefix, u.nickname_th, u.dob,
           (SELECT GROUP_CONCAT(b.name, ', ') FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE ub.user_id = u.id) AS branches
      FROM users u
     WHERE u.role IN ('staff', 'admin') AND u.is_test_account = 0
       AND u.status NOT IN ('disabled', 'resigned', 'terminated')
       AND u.dob IS NOT NULL AND u.dob != ''
  `).all() as Array<{ id: number; display_name: string; title_prefix: string | null; nickname_th: string | null; dob: string; branches: string | null }>;

  const out: BirthdayPerson[] = [];
  for (const daysAhead of BIRTHDAY_LEAD_DAYS) {
    const target = addDays(todayIso, daysAhead);
    const md = target.slice(5);
    const leap = new Date(Date.UTC(Number(target.slice(0, 4)), 1, 29)).getUTCMonth() === 1;
    for (const r of rows) {
      const m = /^\d{4}-(\d{2}-\d{2})/.exec(r.dob);
      if (!m) continue;
      const dobMd = m[1];
      if (dobMd === md || (dobMd === "02-29" && !leap && md === "02-28")) {
        out.push({
          userId: r.id, name: nameWithPrefix(r.title_prefix, r.display_name), nickname: r.nickname_th?.trim() || null,
          branches: r.branches ? r.branches.split(", ") : [], date: target, daysAhead
        });
      }
    }
  }
  return out.sort((a, b) => a.daysAhead - b.daysAhead || a.name.localeCompare(b.name, "th"));
}

const WHEN: Record<number, string> = { 3: "อีก 3 วัน", 2: "อีก 2 วัน", 1: "พรุ่งนี้" };
const longDate = (iso: string) => formatMonthDay(iso, "th");

export function birthdayReminderFlex(people: BirthdayPerson[]): LineFlexMessage {
  const groups = BIRTHDAY_LEAD_DAYS.map((n) => ({ n, list: people.filter((p) => p.daysAhead === n) })).filter((g) => g.list.length > 0);
  const body: unknown[] = [];
  groups.forEach((g, gi) => {
    if (gi > 0) body.push({ type: "separator", margin: "md", color: "#e5e7eb" });
    body.push({ type: "text", text: `${WHEN[g.n]} · ${longDate(g.list[0].date)}`, size: "sm", weight: "bold", color: "#a06820", margin: gi > 0 ? "md" : "none" });
    for (const p of g.list) {
      body.push({
        type: "text", size: "sm", color: "#281a0e", wrap: true, margin: "sm",
        text: `🎂 ${p.name}${p.nickname ? ` (${p.nickname})` : ""}${p.branches.length ? ` · ${p.branches.join(", ")}` : ""}`
      });
    }
  });
  return {
    type: "flex",
    altText: `วันเกิดพนักงานที่กำลังจะถึง ${people.length} คน`,
    contents: {
      type: "bubble", size: "giga",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#281a0e", paddingAll: "20px",
        contents: [
          { type: "text", text: "NOKHOOK OS · PERSONA", color: "#e9c88b", size: "xxs", weight: "bold" },
          { type: "text", text: "วันเกิดพนักงานที่กำลังจะถึง", color: "#ffffff", size: "lg", weight: "bold", margin: "md", wrap: true }
        ]
      },
      body: { type: "box", layout: "vertical", paddingAll: "20px", contents: body },
      styles: { header: { backgroundColor: "#281a0e" }, body: { backgroundColor: "#ffffff" } }
    }
  };
}

/** True once today's reminder was sent (one card per day, however often cron pings). */
export function birthdayReminderSent(todayIso: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM birthday_reminders_sent WHERE remind_date = ?").get(todayIso);
}
export function markBirthdayReminderSent(todayIso: string, count: number): void {
  getDb().prepare("INSERT OR IGNORE INTO birthday_reminders_sent (remind_date, people, sent_at) VALUES (?, ?, ?)")
    .run(todayIso, count, new Date().toISOString());
}
