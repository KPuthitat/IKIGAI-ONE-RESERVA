"use client";

import { useLayoutEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type MeetingPerson = { user_id: number; display_name: string; title_prefix: string | null };
type MinuteItem = { topic: string; details: string; suggestions: string; action_plan: string; owner_user_ids: number[] };
type StaffMeetingView = {
  id: number;
  title: string;
  meeting_date: string;
  status: "scheduled" | "active" | "ended" | "closed";
  invited: boolean;
  joined_at: string | null;
  ended_at: string | null;
  minutes: number | null;
  fee_amount: number | null;
  locked_items: MinuteItem[];   // preset วาระ — topic locked, fill the 3 answers
  extra_items: MinuteItem[];    // วาระ this person added — topic editable
  attendees: MeetingPerson[];   // ผู้รับผิดชอบ pool = the meeting's invitees
  minutes_complete: boolean;
};

type AnswerKey = "details" | "suggestions" | "action_plan";
const ANSWER_FIELDS: Array<{ key: AnswerKey; label: string; placeholder: string }> = [
  { key: "details", label: "รายละเอียด", placeholder: "สาระสำคัญที่คุยกัน" },
  { key: "suggestions", label: "ข้อเสนอแนะ", placeholder: "สิ่งที่เสนอ/ความเห็น" },
  { key: "action_plan", label: "แผนการจัดการ", placeholder: "จะทำอะไรต่อ ใครรับผิดชอบ เมื่อไร" }
];

function fmtMoney(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const blankItem = (): MinuteItem => ({ topic: "", details: "", suggestions: "", action_plan: "", owner_user_ids: [] });
const personLabel = (p: MeetingPerson) => `${p.title_prefix ? `${p.title_prefix} ` : ""}${p.display_name}`;
const answersFilled = (it: MinuteItem) => ANSWER_FIELDS.every((f) => it[f.key].trim().length > 0);
const itemHasContent = (it: MinuteItem) => it.topic.trim() || it.details.trim() || it.suggestions.trim() || it.action_plan.trim();

export default function ExecMeetingStaffClient({ meetings }: { meetings: StaffMeetingView[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  if (meetings.length === 0) {
    return <div className="card text-sm text-slate-500 text-center py-8">ยังไม่มีการประชุมที่คุณได้รับเชิญ</div>;
  }
  return (
    <div className="space-y-3">
      {meetings.map((m) => (
        <MeetingCard key={m.id} m={m} onChanged={() => startTransition(() => router.refresh())} />
      ))}
    </div>
  );
}

function MeetingCard({ m, onChanged }: { m: StaffMeetingView; onChanged: () => void }) {
  // Locked วาระ (topic fixed by admin) — we only edit their 3 answer fields.
  const [locked, setLocked] = useState<MinuteItem[]>(m.locked_items);
  // Own วาระ. Seed one blank block when there's nothing yet, so there's always
  // at least one วาระ to fill in.
  const [extra, setExtra] = useState<MinuteItem[]>(
    m.locked_items.length === 0 && m.extra_items.length === 0 ? [blankItem()] : m.extra_items
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const joined = m.joined_at != null;
  const ended = m.ended_at != null;

  // Ready to finish = every locked วาระ answered, every own วาระ either blank
  // (dropped on save) or fully filled incl. its หัวข้อ, and at least one วาระ.
  const lockedOk = locked.every(answersFilled);
  const extraOk = extra.every((it) => !itemHasContent(it) || (it.topic.trim().length > 0 && answersFilled(it)));
  const totalItems = locked.length + extra.filter(itemHasContent).length;
  const complete = lockedOk && extraOk && totalItems >= 1;

  const setLockedField = (i: number, key: AnswerKey, v: string) =>
    setLocked((prev) => prev.map((it, idx) => (idx === i ? { ...it, [key]: v } : it)));
  const setExtraField = (i: number, key: "topic" | AnswerKey, v: string) =>
    setExtra((prev) => prev.map((it, idx) => (idx === i ? { ...it, [key]: v } : it)));
  const toggleOwner = (list: "locked" | "extra", i: number, uid: number) => {
    const upd = (arr: MinuteItem[]) => arr.map((it, idx) => idx === i
      ? { ...it, owner_user_ids: it.owner_user_ids.includes(uid) ? it.owner_user_ids.filter((x) => x !== uid) : [...it.owner_user_ids, uid] }
      : it);
    if (list === "locked") setLocked(upd); else setExtra(upd);
  };
  const addExtra = () => setExtra((prev) => [...prev, blankItem()]);
  const removeExtra = (i: number) => setExtra((prev) => prev.filter((_, idx) => idx !== i));

  function payload(): Record<string, unknown> {
    return {
      action: "minutes",
      locked_answers: locked.map(({ details, suggestions, action_plan }) => ({ details, suggestions, action_plan })),
      extra_items: extra
    };
  }

  async function post(body: Record<string, unknown>, tag: string): Promise<Record<string, unknown> | null> {
    setBusy(tag); setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/persona/exec-meetings/${m.id}`), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!j?.ok) { setMsg({ kind: "err", text: j?.message ?? j?.error ?? "ผิดพลาด" }); return null; }
      return j;
    } catch { setMsg({ kind: "err", text: "เชื่อมต่อไม่ได้" }); return null; }
    finally { setBusy(null); }
  }

  async function join() { if (await post({ action: "join" }, "join")) onChanged(); }
  async function saveMinutes() {
    if (await post(payload(), "minutes")) setMsg({ kind: "ok", text: "บันทึกรายงานแล้ว" });
  }
  async function end() {
    // Persist the latest minutes first so a just-typed field isn't lost.
    const saved = await post(payload(), "end");
    if (!saved) return;
    const done = await post({ action: "end" }, "end");
    if (done) { setMsg({ kind: "ok", text: `สิ้นสุดการประชุม · ${done.minutes} นาที · เบี้ยประชุม ฿${fmtMoney(Number(done.fee) || 0)}` }); onChanged(); }
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-800 leading-snug">{m.title}</div>
          <div className="text-xs text-slate-500 mt-0.5">{m.meeting_date}</div>
        </div>
        <StatusBadge status={m.status} joined={joined} ended={ended} />
      </div>

      {ended ? (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800">
          เข้าร่วม {m.minutes ?? 0} นาที · เบี้ยประชุม ฿{fmtMoney(m.fee_amount ?? 0)}
          <div className="text-xs text-emerald-600 mt-0.5">เบี้ยประชุมจะรวมเข้าค่าตอบแทนในรอบถัดไป</div>
        </div>
      ) : m.status !== "active" ? (
        <div className="text-sm text-slate-400">การประชุมยังไม่เปิด — รอแอดมินเปิดประชุม</div>
      ) : !joined ? (
        <button type="button" onClick={join} disabled={busy != null}
          className="btn-primary text-sm disabled:opacity-50">
          {busy === "join" ? "..." : "เข้าร่วมประชุม"}
        </button>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-slate-500">
            ตอบให้ครบทุกช่องของทุกวาระก่อนสิ้นสุดการประชุม · ถ้าไม่มีให้เขียนว่า &ldquo;ไม่มี&rdquo;
          </div>

          {locked.map((it, i) => (
            <AgendaBlock key={`L${i}`} index={i + 1} topic={it.topic} locked item={it} attendees={m.attendees}
              onAnswer={(key, v) => setLockedField(i, key, v)}
              onToggleOwner={(uid) => toggleOwner("locked", i, uid)} />
          ))}

          {extra.map((it, i) => (
            <AgendaBlock key={`E${i}`} index={locked.length + i + 1} topic={it.topic} item={it} attendees={m.attendees}
              onTopic={(v) => setExtraField(i, "topic", v)}
              onAnswer={(key, v) => setExtraField(i, key, v)}
              onToggleOwner={(uid) => toggleOwner("extra", i, uid)}
              onRemove={() => removeExtra(i)} />
          ))}

          <button type="button" onClick={addExtra}
            className="w-full rounded-xl border border-dashed border-[#d8c6ab] text-brand text-sm font-medium py-3 my-1 hover:bg-[#faf5ec] active:bg-[#f3e9d8]">
            + เพิ่มวาระ
          </button>

          <div className="flex items-center gap-3">
            <button type="button" onClick={saveMinutes} disabled={busy != null} className="btn-secondary text-sm disabled:opacity-50">
              {busy === "minutes" ? "..." : "บันทึกรายงาน"}
            </button>
            <button type="button" onClick={end} disabled={busy != null || !complete}
              title={!complete ? "ตอบให้ครบทุกช่องของทุกวาระก่อน" : undefined}
              className="btn-primary text-sm disabled:opacity-50">
              {busy === "end" ? "..." : "สิ้นสุดการประชุม"}
            </button>
          </div>
        </div>
      )}

      {msg && <div className={`text-xs ${msg.kind === "ok" ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</div>}
    </div>
  );
}

// One วาระ block: a หัวข้อ (locked header for preset วาระ, editable input for own),
// the three answer fields, and ผู้รับผิดชอบ (pick 0..n from the meeting's people).
// Own วาระ can be removed.
function AgendaBlock({ index, topic, item, attendees, locked, onTopic, onAnswer, onToggleOwner, onRemove }: {
  index: number; topic: string; item: MinuteItem; attendees: MeetingPerson[]; locked?: boolean;
  onTopic?: (v: string) => void; onAnswer: (key: AnswerKey, v: string) => void;
  onToggleOwner: (uid: number) => void; onRemove?: () => void;
}) {
  return (
    <div className="rounded-xl border border-[#EFE4D3] bg-white/60 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-brand">วาระที่ {index}</span>
        {locked ? (
          <span className="text-[10px] bg-slate-100 text-slate-500 rounded-full px-2 py-0.5">หัวข้อจากผู้จัด</span>
        ) : onRemove ? (
          <button type="button" onClick={onRemove} className="text-[11px] text-rose-500 hover:underline">ลบวาระ</button>
        ) : null}
      </div>
      {locked ? (
        <div className="rounded-lg bg-[#f6efe3] px-3 py-2 text-sm font-medium text-[#4a3f30]">{topic}</div>
      ) : (
        <div>
          <label className="label">หัวข้อวาระ{topic.trim() ? "" : <span className="text-rose-400"> *</span>}</label>
          <input className="input" value={topic} placeholder="หัวข้อ/วาระที่ประชุม"
            onChange={(e) => onTopic?.(e.target.value)} />
        </div>
      )}
      {ANSWER_FIELDS.map((f) => (
        <div key={f.key}>
          <label className="label">{f.label}{item[f.key].trim() ? "" : <span className="text-rose-400"> *</span>}</label>
          <AutoTextarea value={item[f.key]} placeholder={f.placeholder} onChange={(v) => onAnswer(f.key, v)} />
        </div>
      ))}
      {attendees.length > 0 && (
        <div>
          <label className="label">ผู้รับผิดชอบ <span className="text-slate-400 font-normal">(เลือกได้หลายคน)</span></label>
          <div className="flex flex-wrap gap-1.5">
            {attendees.map((p) => {
              const on = item.owner_user_ids.includes(p.user_id);
              return (
                <button key={p.user_id} type="button" onClick={() => onToggleOwner(p.user_id)}
                  className={`text-xs rounded-full px-2.5 py-1 border transition-colors ${on
                    ? "bg-brand text-white border-brand"
                    : "bg-white text-slate-600 border-[#e3d6c0] hover:bg-[#faf5ec]"}`}>
                  {on ? "✓ " : ""}{personLabel(p)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// เวลาโน้ตประชุมมักยาว (owner 2026-09-02) — ช่องขยายสูงตามข้อความที่พิมพ์เอง
// ไม่ต้อง scroll ในกล่องเล็กๆ. Grows to fit content on type และตอนโหลดค่าที่บันทึกไว้.
function AutoTextarea({ value, placeholder, onChange }: {
  value: string; placeholder: string; onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="input min-h-[64px]"
      style={{ overflow: "hidden", resize: "none" }}
      rows={2}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function StatusBadge({ status, joined, ended }: { status: string; joined: boolean; ended: boolean }) {
  const [label, style] = ended
    ? ["จบแล้ว", "bg-slate-100 text-slate-500"]
    : joined
    ? ["กำลังเข้าร่วม", "bg-emerald-100 text-emerald-700"]
    : status === "active"
    ? ["เปิดให้เข้าร่วม", "bg-amber-100 text-amber-700"]
    : ["ยังไม่เปิด", "bg-slate-100 text-slate-500"];
  return <span className={`shrink-0 whitespace-nowrap text-[11px] px-2 py-1 rounded-full font-medium ${style}`}>{label}</span>;
}
