"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";
import type { MeetingRow, ActionItemRow } from "@/lib/meetings";

export type StaffOption = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  nickname_th: string | null;
};

const staffLabel = (s: StaffOption) => s.nickname_th?.trim() || nameWithPrefix(s.title_prefix, s.display_name);

export default function MeetingDetailClient({
  meeting, items, staff, aiEnabled = false
}: { meeting: MeetingRow; items: ActionItemRow[]; staff: StaffOption[]; aiEnabled?: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());
  const [busyId, setBusyId] = useState<number | null>(null);

  // ── AI: สร้างเช็กลิสต์จากสรุปการประชุม ──
  const [suggesting, setSuggesting] = useState(false);
  const [suggested, setSuggested] = useState<Array<{ title: string; include: boolean }> | null>(null);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [savingAll, setSavingAll] = useState(false);

  async function suggestAI() {
    setSuggesting(true); setAiErr(null); setSuggested(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/meetings/${meeting.id}/suggest-items`), { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setAiErr(j.message ?? j.error ?? "สร้างเช็กลิสต์ไม่สำเร็จ"); return; }
      const items: string[] = j.items ?? [];
      if (items.length === 0) { setAiErr("AI ไม่พบงานที่ต้องทำจากสรุปนี้"); return; }
      setSuggested(items.map((t) => ({ title: t, include: true })));
    } catch {
      setAiErr("เกิดข้อผิดพลาด ลองใหม่อีกครั้ง");
    } finally {
      setSuggesting(false);
    }
  }

  async function addSelected() {
    if (!suggested) return;
    const chosen = suggested.filter((s) => s.include && s.title.trim());
    if (chosen.length === 0) { setSuggested(null); return; }
    setSavingAll(true); setAiErr(null);
    // เก็บเฉพาะรายการที่บันทึก "ไม่สำเร็จ" ไว้ให้ผู้ใช้ลองใหม่ — รายการที่สำเร็จแล้ว
    // ถูกลบออกจากลิสต์ กันกดซ้ำแล้วเพิ่มซ้ำ (dup). เช็ค res.ok เพราะ fetch ไม่ reject
    // ตอน HTTP error.
    const failed: Array<{ title: string; include: boolean }> = [];
    let anyOk = false;
    for (const s of chosen) {
      let ok = false;
      try {
        const res = await fetch(apiUrl(`/api/admin/persona/meetings/${meeting.id}/items`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: s.title.trim(), assignee_user_id: null, due_date: null })
        });
        ok = res.ok;
      } catch { ok = false; }
      if (ok) anyOk = true; else failed.push(s);
    }
    // คงเฉพาะที่ยังไม่ถูกเลือก (include=false) + ที่บันทึกไม่สำเร็จ
    const remaining = [...suggested.filter((s) => !(s.include && s.title.trim())), ...failed];
    setSuggested(remaining.length ? remaining : null);
    if (failed.length) setAiErr(`บันทึกไม่สำเร็จ ${failed.length} รายการ — ลองใหม่อีกครั้ง`);
    if (anyOk) refresh();
    setSavingAll(false);
  }

  async function toggle(item: ActionItemRow) {
    setBusyId(item.id);
    try {
      await fetch(apiUrl(`/api/persona/meeting-items/${item.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: item.status === "open" ? "done" : "reopen" })
      });
      refresh();
    } finally { setBusyId(null); }
  }

  async function removeItem(item: ActionItemRow) {
    if (!confirm(`ลบงาน "${item.title}" ?`)) return;
    setBusyId(item.id);
    try {
      await fetch(apiUrl(`/api/persona/meeting-items/${item.id}`), { method: "DELETE" });
      refresh();
    } finally { setBusyId(null); }
  }

  async function removeMeeting() {
    if (!confirm("ลบบันทึกการประชุมนี้ทั้งหมด (รวมงานที่มอบหมาย) ?")) return;
    const res = await fetch(apiUrl(`/api/admin/persona/meetings/${meeting.id}`), { method: "DELETE" });
    if (res.ok) router.push("/admin/persona/meetings");
  }

  const openItems = items.filter((i) => i.status === "open");
  const doneItems = items.filter((i) => i.status === "done");
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <div className="card space-y-2">
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
          <span className="text-xs text-slate-400 font-mono">{meeting.meeting_date}</span>
          <h1 className="text-xl font-bold text-slate-800">{meeting.title}</h1>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
            {meeting.branch_name ?? "ทั้งบริษัท"}
          </span>
          <span className="flex-1" />
          <button type="button" onClick={removeMeeting}
            className="text-xs px-3 py-1 rounded border border-rose-200 text-rose-500 hover:bg-rose-50">
            ลบการประชุม
          </button>
        </div>
        {meeting.summary
          ? <p className="text-sm text-slate-700 whitespace-pre-wrap">{meeting.summary}</p>
          : <p className="text-sm text-slate-400">— ไม่มีสรุป —</p>}
        {meeting.created_by_name && (
          <p className="text-[11px] text-slate-400">บันทึกโดย {meeting.created_by_name}</p>
        )}
      </div>

      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="font-bold text-slate-800 text-sm">
            เชคลิสต์งานหลังประชุม
            {items.length > 0 && (
              <span className="ml-2 text-[11px] font-normal text-slate-400">
                เสร็จ {doneItems.length}/{items.length}
              </span>
            )}
          </h2>
          {aiEnabled && meeting.summary?.trim() && (
            <button type="button" disabled={suggesting} onClick={suggestAI}
              className="text-xs px-3 py-1.5 rounded-md border border-brand text-brand font-bold hover:bg-brand/5 disabled:opacity-50">
              {suggesting ? "AI กำลังคิด…" : "สร้างเช็กลิสต์ด้วย AI"}
            </button>
          )}
        </div>

        {aiErr && <p className="text-xs text-rose-600">{aiErr}</p>}

        {suggested && (
          <div className="rounded-lg border border-brand/30 bg-brand/5 p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold text-slate-700">
                AI เสนอ {suggested.length} งาน — เลือก/แก้ไขก่อนเพิ่ม
              </span>
              <span className="flex-1" />
              <button type="button" onClick={() => setSuggested(null)}
                className="text-[11px] text-slate-400 hover:text-slate-600">ยกเลิก</button>
            </div>
            <div className="space-y-1.5">
              {suggested.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="checkbox" checked={s.include}
                    onChange={(e) => setSuggested((arr) =>
                      arr!.map((x, idx) => idx === i ? { ...x, include: e.target.checked } : x))} />
                  <input className="input flex-1 !py-1 text-sm" value={s.title}
                    onChange={(e) => setSuggested((arr) =>
                      arr!.map((x, idx) => idx === i ? { ...x, title: e.target.value } : x))} />
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <button type="button" disabled={savingAll || !suggested.some((s) => s.include && s.title.trim())}
                onClick={addSelected}
                className="text-xs px-4 py-1.5 rounded-md bg-brand text-white font-bold hover:opacity-90 disabled:opacity-40">
                {savingAll ? "กำลังเพิ่ม…" : `＋ เพิ่มที่เลือก (${suggested.filter((s) => s.include && s.title.trim()).length})`}
              </button>
            </div>
            <p className="text-[10px] text-slate-400">
              * AI ช่วยร่างจากสรุปการประชุม โปรดตรวจทานก่อนเพิ่ม — มอบหมายผู้รับผิดชอบ/กำหนดส่งได้ที่รายการด้านล่างหลังเพิ่ม
            </p>
          </div>
        )}

        {items.length === 0 && <p className="text-sm text-slate-400">ยังไม่มีงานมอบหมาย</p>}

        {openItems.length > 0 && (
          <div className="space-y-1.5">
            {openItems.map((it) => (
              <ItemRow key={it.id} item={it} today={today} busy={busyId === it.id}
                onToggle={() => toggle(it)} onDelete={() => removeItem(it)} />
            ))}
          </div>
        )}

        {doneItems.length > 0 && (
          <details className="pt-1">
            <summary className="cursor-pointer text-xs font-medium text-slate-500 select-none">
              เสร็จแล้ว ({doneItems.length})
            </summary>
            <div className="space-y-1.5 mt-2">
              {doneItems.map((it) => (
                <ItemRow key={it.id} item={it} today={today} busy={busyId === it.id}
                  onToggle={() => toggle(it)} onDelete={() => removeItem(it)} />
              ))}
            </div>
          </details>
        )}

        <AddItem meetingId={meeting.id} staff={staff} onAdded={refresh} />
      </div>
    </div>
  );
}

function ItemRow({
  item, today, busy, onToggle, onDelete
}: { item: ActionItemRow; today: string; busy: boolean; onToggle: () => void; onDelete: () => void }) {
  const done = item.status === "done";
  const overdue = !done && item.due_date != null && item.due_date < today;
  return (
    <div className="flex items-center gap-2 text-sm border-t border-slate-100 pt-1.5 first:border-t-0">
      <button type="button" disabled={busy} onClick={onToggle}
        className={`shrink-0 w-5 h-5 rounded border flex items-center justify-center text-xs ${
          done ? "bg-emerald-500 border-emerald-500 text-white" : "border-slate-300 text-transparent hover:border-emerald-400"
        }`}>
        ✓
      </button>
      <div className="flex-1 min-w-0">
        <span className={done ? "line-through text-slate-400" : "text-slate-800"}>{item.title}</span>
        <div className="flex flex-wrap gap-x-2 text-[11px] text-slate-400">
          {item.assignee_name && (
            <span>{item.assignee_prefix ? nameWithPrefix(item.assignee_prefix, item.assignee_name) : item.assignee_name}</span>
          )}
          {item.due_date && (
            <span className={overdue ? "text-rose-500 font-medium" : ""}>
              กำหนด {item.due_date}{overdue ? " · เลยกำหนด" : ""}
            </span>
          )}
        </div>
      </div>
      <button type="button" disabled={busy} onClick={onDelete}
        className="shrink-0 text-[11px] text-slate-300 hover:text-rose-500">ลบ</button>
    </div>
  );
}

function AddItem({ meetingId, staff, onAdded }: { meetingId: number; staff: StaffOption[]; onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/meetings/${meetingId}/items`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          assignee_user_id: assignee ? Number(assignee) : null,
          due_date: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null
        })
      });
      if (res.ok) { setTitle(""); setAssignee(""); setDue(""); onAdded(); }
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3">
      <div className="flex-1 min-w-[160px]">
        <label className="text-[10px] text-slate-400 block">เพิ่มงาน</label>
        <input className="input w-full !py-1 text-sm" value={title}
          onChange={(e) => setTitle(e.target.value)} placeholder="สิ่งที่ต้องทำ" />
      </div>
      <select className="input !w-auto !py-1 text-sm" value={assignee}
        onChange={(e) => setAssignee(e.target.value)}>
        <option value="">— ผู้รับผิดชอบ —</option>
        {staff.map((s) => <option key={s.id} value={s.id}>{staffLabel(s)}</option>)}
      </select>
      <input type="date" className="input !w-auto !py-1 text-sm" value={due}
        onChange={(e) => setDue(e.target.value)} />
      <button type="button" disabled={busy || !title.trim()} onClick={add}
        className="text-xs px-4 py-1.5 rounded-md bg-brand text-white font-bold hover:opacity-90 disabled:opacity-50">
        เพิ่ม
      </button>
    </div>
  );
}
