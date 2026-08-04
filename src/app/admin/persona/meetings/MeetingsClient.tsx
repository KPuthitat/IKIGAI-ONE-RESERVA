"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";
import type { MeetingRow } from "@/lib/meetings";

export type StaffOption = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  nickname_th: string | null;
};

type DraftItem = { title: string; assignee: string; due: string };

const todayBkk = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

export default function MeetingsClient({ meetings, staff }: { meetings: MeetingRow[]; staff: StaffOption[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button type="button" onClick={() => setOpen((v) => !v)}
          className="text-sm px-4 py-1.5 rounded-md bg-brand text-white font-bold hover:opacity-90">
          {open ? "ปิดฟอร์ม" : "＋ สร้างการประชุม"}
        </button>
      </div>

      {open && (
        <CreateForm staff={staff} onDone={() => { setOpen(false); startTransition(() => router.refresh()); }} />
      )}

      <div className="space-y-2">
        {meetings.length === 0 ? (
          <div className="card text-sm text-slate-400 text-center py-8">ยังไม่มีบันทึกการประชุม</div>
        ) : meetings.map((m) => (
          <Link key={m.id} href={`/admin/persona/meetings/${m.id}`}
            className="card block hover:bg-slate-50 transition">
            <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
              <span className="text-xs text-slate-400 font-mono">{m.meeting_date}</span>
              <span className="font-bold text-slate-800">{m.title}</span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                {m.branch_name ?? "ทั้งบริษัท"}
              </span>
              <span className="flex-1" />
              {m.item_count > 0 ? (
                <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                  m.open_count > 0 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
                }`}>
                  {m.open_count > 0 ? `ค้าง ${m.open_count}/${m.item_count} งาน` : `เสร็จครบ ${m.item_count} งาน`}
                </span>
              ) : (
                <span className="text-[11px] text-slate-400">ไม่มีงานมอบหมาย</span>
              )}
            </div>
            {m.summary && (
              <p className="text-xs text-slate-500 mt-1 line-clamp-2 whitespace-pre-wrap">{m.summary}</p>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

function CreateForm({ staff, onDone }: { staff: StaffOption[]; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(todayBkk());
  const [companyWide, setCompanyWide] = useState(false);
  const [summary, setSummary] = useState("");
  const [items, setItems] = useState<DraftItem[]>([{ title: "", assignee: "", due: "" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const setItem = (i: number, patch: Partial<DraftItem>) =>
    setItems((arr) => arr.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const addItem = () => setItems((arr) => [...arr, { title: "", assignee: "", due: "" }]);
  const removeItem = (i: number) => setItems((arr) => arr.filter((_, idx) => idx !== i));

  const ready = title.trim() !== "" && /^\d{4}-\d{2}-\d{2}$/.test(date);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const payloadItems = items
        .filter((it) => it.title.trim() !== "")
        .map((it) => ({
          title: it.title.trim(),
          assignee_user_id: it.assignee ? Number(it.assignee) : null,
          due_date: /^\d{4}-\d{2}-\d{2}$/.test(it.due) ? it.due : null
        }));
      const res = await fetch(apiUrl("/api/admin/persona/meetings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(), meeting_date: date, summary: summary.trim(),
          company_wide: companyWide, items: payloadItems
        })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) { onDone(); return; }
      setErr(j?.error ?? "ไม่สำเร็จ");
    } finally { setBusy(false); }
  }

  return (
    <div className="card space-y-3">
      <h2 className="font-bold text-slate-800 text-sm">สร้างบันทึกการประชุม</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] text-slate-500 block">หัวข้อการประชุม</label>
          <input className="input w-full !py-1 text-sm" value={title}
            onChange={(e) => setTitle(e.target.value)} placeholder="เช่น ประชุมประจำเดือน สิงหาคม" />
        </div>
        <div>
          <label className="text-[11px] text-slate-500 block">วันที่</label>
          <input type="date" className="input !w-auto !py-1 text-sm" value={date}
            onChange={(e) => setDate(e.target.value)} />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 pb-1.5">
          <input type="checkbox" checked={companyWide} onChange={(e) => setCompanyWide(e.target.checked)} />
          ทั้งบริษัท (ทุกสาขา)
        </label>
      </div>

      <div>
        <label className="text-[11px] text-slate-500 block">สรุป / มติที่ประชุม</label>
        <textarea className="input w-full !py-1 text-sm min-h-[90px]" value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="บันทึกประเด็นที่คุย มติ และข้อตกลง…" />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold text-slate-600">งานที่ต้องทำต่อ (มอบหมายรายคน)</span>
          <button type="button" onClick={addItem}
            className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50">
            ＋ เพิ่มงาน
          </button>
        </div>
        {items.map((it, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">
            <div className="flex-1 min-w-[180px]">
              <label className="text-[10px] text-slate-400 block">สิ่งที่ต้องทำ</label>
              <input className="input w-full !py-1 text-sm" value={it.title}
                onChange={(e) => setItem(i, { title: e.target.value })} placeholder="เช่น สั่งวัตถุดิบเพิ่ม" />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 block">ผู้รับผิดชอบ</label>
              <select className="input !w-auto !py-1 text-sm" value={it.assignee}
                onChange={(e) => setItem(i, { assignee: e.target.value })}>
                <option value="">— ไม่ระบุ —</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.nickname_th?.trim() || nameWithPrefix(s.title_prefix, s.display_name)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-slate-400 block">กำหนดเสร็จ</label>
              <input type="date" className="input !w-auto !py-1 text-sm" value={it.due}
                onChange={(e) => setItem(i, { due: e.target.value })} />
            </div>
            {items.length > 1 && (
              <button type="button" onClick={() => removeItem(i)}
                className="text-xs px-2 py-1.5 rounded border border-rose-200 text-rose-500 hover:bg-rose-50">
                ลบ
              </button>
            )}
          </div>
        ))}
      </div>

      {err && <p className="text-xs text-rose-600">{err}</p>}
      <div className="flex justify-end">
        <button type="button" disabled={busy || !ready} onClick={submit}
          className="text-sm px-5 py-1.5 rounded-md bg-brand text-white font-bold hover:opacity-90 disabled:opacity-50">
          บันทึกการประชุม
        </button>
      </div>
    </div>
  );
}
