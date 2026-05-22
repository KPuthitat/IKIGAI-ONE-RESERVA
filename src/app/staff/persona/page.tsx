import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { nameWithPrefix } from "@/lib/name";
import TimeClockClient from "./TimeClockClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PERSONA · ลงเวลา" };

type TimeEntry = { id: number; type: "in" | "out"; ts: string };

export default function StaffPersonaPage() {
  const user = requireUser();
  const db = getDb();

  // Pull the active branch row so the client knows which anti-cheat
  // gates are enabled (geofence / QR). Without it the clock-in
  // button would naively submit and only learn about the failure
  // from the API error — bad UX. We also pre-feed the branch name
  // so the UI can mention "you must be at NAMA PASTA SRIRACHA" etc.
  const branch = user.activeBranchId
    ? (db.prepare("SELECT * FROM branches WHERE id = ?")
        .get(user.activeBranchId) as Branch | undefined)
    : undefined;

  const entries = db.prepare(`
    SELECT id, type, ts FROM time_entries
    WHERE user_id = ? AND ts >= datetime('now', '-7 days')
    ORDER BY ts DESC LIMIT 100
  `).all(user.id) as TimeEntry[];

  // เลือก entries ของวันนี้ตาม Bangkok local
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const todayEntries = entries.filter((e) =>
    new Date(new Date(e.ts).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10) === todayBkk
  );

  // ส่งเฉพาะ ts ของ in/out แรก ไปให้ client คำนวณ nextAction + 5-min window เอง
  // (ง่ายต่อการ re-evaluate ทุกวินาทีตามนาฬิกาที่วิ่งอยู่)
  const inSorted = todayEntries.filter((e) => e.type === "in").sort((a, b) => a.ts.localeCompare(b.ts));
  const outSorted = todayEntries.filter((e) => e.type === "out").sort((a, b) => a.ts.localeCompare(b.ts));
  const firstInTs = inSorted[0]?.ts ?? null;
  const firstOutTs = outSorted[0]?.ts ?? null;

  // ตรวจว่า user มี PIN หรือยัง
  const userRow = db.prepare("SELECT pin_hash FROM users WHERE id = ?").get(user.id) as
    | { pin_hash: string | null } | undefined;
  const hasPin = Boolean(userRow?.pin_hash);

  return (
    <TimeClockClient
      userName={nameWithPrefix(user.title_prefix, user.display_name)}
      hasPin={hasPin}
      firstInTs={firstInTs}
      firstOutTs={firstOutTs}
      entries={entries}
      branchName={branch?.name ?? null}
      geofenceEnabled={branch?.geofence_enabled === 1}
      geofenceLat={branch?.latitude ?? null}
      geofenceLng={branch?.longitude ?? null}
      geofenceRadiusMeters={branch?.geofence_radius_meters ?? 100}
      qrEnabled={branch?.clock_qr_enabled === 1}
    />
  );
}
