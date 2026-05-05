import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, type Branch } from "@/lib/db";
import { suggestTables } from "@/lib/table-allocator";

const Body = z.object({
  branch_slug: z.string(),
  party_size: z.number().int().min(1).max(50),
  booking_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  booking_time: z.string().regex(/^\d{2}:\d{2}$/)
});

export async function POST(req: Request) {
  const json = await req.json();
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง", issues: parsed.error.issues }, { status: 400 });
  }
  const { branch_slug, party_size, booking_date, booking_time } = parsed.data;

  const branch = getDb().prepare("SELECT * FROM branches WHERE slug = ?").get(branch_slug) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "ไม่พบสาขา" }, { status: 404 });

  // ห้ามจองย้อนหลัง
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (booking_date < todayBkk) {
    return NextResponse.json({ error: "ไม่สามารถจองย้อนหลังได้" }, { status: 400 });
  }

  const suggestions = suggestTables({
    branchId: branch.id,
    date: booking_date,
    time: booking_time,
    durationMinutes: branch.default_duration_minutes,
    partySize: party_size,
    limit: 5
  });

  return NextResponse.json({
    suggestions: suggestions.map((s) => ({
      id: s.table.id,
      label: s.table.label,
      capacity: s.table.capacity,
      shape: s.table.shape,
      fitScore: s.fitScore
    }))
  });
}
