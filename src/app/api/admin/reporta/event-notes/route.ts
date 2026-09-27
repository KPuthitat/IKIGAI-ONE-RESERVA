import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { listEventNotes, addEventNote, deleteEventNote, EVENT_NOTE_MAX } from "@/lib/event-notes";

// Team-tagged daily event notes for the ANALYTICA forward plan (owner 2026-09-27:
// "เพิ่มโน้ตเหตุการณ์รายวันให้ทีมแท็กเองด้วย"). GET lists a date range, POST tags a
// day, DELETE removes one note. Branch-scoped to the caller's active branch.

export const dynamic = "force-dynamic";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function activeBranch(): { branchId: number; userId: number } | null {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return null;
  return { branchId, userId: user.id };
}

export async function GET(req: Request) {
  const ctx = activeBranch();
  if (!ctx) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const from = sp.get("from");
  const to = sp.get("to");
  const startIso = from && ISO.test(from) ? from : today;
  const endIso = to && ISO.test(to) ? to : startIso;
  return NextResponse.json({ ok: true, notes: listEventNotes(ctx.branchId, startIso, endIso) });
}

// .trim() before min/max so a note that fits once surrounding whitespace is
// stripped isn't rejected (addEventNote trims + caps the same way).
const PostBody = z.object({ date: z.string().regex(ISO), note: z.string().trim().min(1).max(EVENT_NOTE_MAX) });

export async function POST(req: Request) {
  const ctx = activeBranch();
  if (!ctx) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const note = addEventNote(ctx.branchId, parsed.data.date, parsed.data.note, ctx.userId);
  if (!note) return NextResponse.json({ error: "invalid_note", message: "โน้ตว่างหรือวันที่ไม่ถูกต้อง" }, { status: 400 });
  return NextResponse.json({ ok: true, note });
}

export async function DELETE(req: Request) {
  const ctx = activeBranch();
  if (!ctx) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const ok = deleteEventNote(ctx.branchId, id);
  if (!ok) return NextResponse.json({ error: "not_found", message: "ไม่พบโน้ต (อาจถูกลบไปแล้ว)" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
