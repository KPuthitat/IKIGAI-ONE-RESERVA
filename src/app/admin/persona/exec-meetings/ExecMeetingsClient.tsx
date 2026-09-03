"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

export type StaffLite = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  fee_exempt: boolean;
  branchId: number;
  department: string | null;
};
export type BranchLite = { id: number; name: string };

type MeetingRow = {
  id: number;
  title: string;
  meeting_date: string;
  branch_name: string | null;
  status: "scheduled" | "active" | "ended" | "closed";
  invitee_count: number;
  joined_count: number;
  ended_count: number;
};

const STATUS_LABEL: Record<MeetingRow["status"], string> = {
  scheduled: "ตั้งไว้",
  active: "กำลังประชุม",
  ended: "จบแล้ว",
  closed: "ปิดรอบ"
};
const STATUS_STYLE: Record<MeetingRow["status"], string> = {
  scheduled: "bg-slate-100 text-slate-600",
  active: "bg-emerald-100 text-emerald-700",
  ended: "bg-amber-100 text-amber-700",
  closed: "bg-slate-200 text-slate-500"
};

const NO_DEPT = "ไม่ระบุแผนก";
// Group a branch's staff by แผนก (department). Departments A→Z, "ไม่ระบุแผนก" last;
// people keep their incoming (name) order.
function groupByDept(list: StaffLite[]): Array<{ dept: string; people: StaffLite[] }> {
  const map = new Map<string, StaffLite[]>();
  for (const s of list) {
    const d = s.department?.trim() || NO_DEPT;
    (map.get(d) ?? map.set(d, []).get(d)!).push(s);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] === NO_DEPT ? 1 : b[0] === NO_DEPT ? -1 : a[0].localeCompare(b[0], "th")))
    .map(([dept, people]) => ({ dept, people }));
}

// Look up an owner's display name from the meeting's invitee list.
function ownerName(invitees: Array<{ user_id: number; display_name: string; title_prefix: string | null }>, uid: number): string {
  const p = invitees.find((i) => i.user_id === uid);
  if (!p) return `#${uid}`;
  return `${p.title_prefix ? `${p.title_prefix} ` : ""}${p.display_name}`;
}

function bkkToday(): string {
  const now = new Date();
  const bkk = new Date(now.getTime() + (now.getTimezoneOffset() + 420) * 60000);
  return bkk.toISOString().slice(0, 10);
}

export default function ExecMeetingsClient({ staff, branches, meetings }: { staff: StaffLite[]; branches: BranchLite[]; meetings: MeetingRow[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [title, setTitle] = useState("");
  const [date, setDate] = useState(bkkToday());
  const [companyWide, setCompanyWide] = useState(false);
  const [topics, setTopics] = useState<string[]>([]);
  const [invited, setInvited] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);

  const setTopic = (i: number, v: string) => setTopics((prev) => prev.map((t, idx) => (idx === i ? v : t)));
  const addTopic = () => setTopics((prev) => [...prev, ""]);
  const removeTopic = (i: number) => setTopics((prev) => prev.filter((_, idx) => idx !== i));

  function toggleInvite(id: number) {
    setInvited((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function create() {
    if (!title.trim()) { setMsg({ kind: "err", text: "ใส่หัวข้อการประชุมก่อน" }); return; }
    if (invited.size === 0) { setMsg({ kind: "err", text: "เลือกผู้ได้รับเชิญอย่างน้อย 1 คน" }); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/exec-meetings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(), meeting_date: date, company_wide: companyWide,
          agenda_topics: topics.map((t) => t.trim()).filter(Boolean),
          invitee_user_ids: Array.from(invited)
        })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        setTitle(""); setInvited(new Set()); setCompanyWide(false); setTopics([]);
        setMsg({ kind: "ok", text: "สร้างการประชุมแล้ว" });
        startTransition(() => router.refresh());
      } else {
        setMsg({ kind: "err", text: j?.error === "no_active_branch" ? "ยังไม่ได้เลือกสาขา" : (j?.error ?? "ผิดพลาด") });
      }
    } catch { setMsg({ kind: "err", text: "เชื่อมต่อไม่ได้" }); }
    finally { setBusy(false); }
  }

  async function setStatus(id: number, status: MeetingRow["status"]) {
    await fetch(apiUrl(`/api/admin/persona/exec-meetings/${id}`), {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    startTransition(() => router.refresh());
  }

  async function remove(id: number) {
    if (!confirm("ลบการประชุมนี้? (ข้อมูลการเข้าร่วมและรายงานจะถูกลบทั้งหมด)")) return;
    await fetch(apiUrl(`/api/admin/persona/exec-meetings/${id}`), { method: "DELETE" });
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-5">
      {/* Create */}
      <div className="card space-y-3">
        <div className="text-sm font-semibold text-slate-700">ตั้งการประชุมใหม่</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">หัวข้อการประชุม</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="เช่น ประชุมผู้บริหารประจำสัปดาห์" />
          </div>
          <div>
            <label className="label">วันที่ประชุม</label>
            <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={companyWide} onChange={(e) => setCompanyWide(e.target.checked)} />
          ประชุมระดับบริษัท (ทุกสาขา)
        </label>

        {/* Preset วาระ (owner 2026-09-02): topics set here are locked headers each
            attendee must answer; they can still add their own วาระ on top. */}
        <div>
          <div className="label flex items-center justify-between">
            <span>วาระการประชุม (ตั้งล่วงหน้า)</span>
            <button type="button" className="text-xs text-brand hover:underline" onClick={addTopic}>+ เพิ่มวาระ</button>
          </div>
          {topics.length === 0 ? (
            <div className="text-xs text-slate-400">ยังไม่ได้ตั้งวาระ — พนักงานจะเพิ่มวาระเองได้ตอนประชุม (หรือกด &ldquo;เพิ่มวาระ&rdquo; เพื่อกำหนดหัวข้อล่วงหน้า)</div>
          ) : (
            <div className="space-y-1.5">
              {topics.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 w-5 text-right tabular-nums">{i + 1}.</span>
                  <input className="input flex-1" value={t} placeholder="เช่น สรุปยอดขายสัปดาห์นี้"
                    onChange={(e) => setTopic(i, e.target.value)} />
                  <button type="button" onClick={() => removeTopic(i)} className="text-rose-400 hover:text-rose-600 text-lg leading-none px-1">×</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="label flex items-center justify-between">
            <span>เลือกผู้ได้รับเชิญ ({invited.size})</span>
            {staff.length > 0 && (
              <button type="button" className="text-xs text-brand hover:underline"
                onClick={() => setInvited(invited.size === staff.length ? new Set() : new Set(staff.map((s) => s.id)))}>
                {invited.size === staff.length ? "ล้างทั้งหมด" : "เลือกทั้งหมด"}
              </button>
            )}
          </div>
          {staff.length === 0 ? (
            <div className="text-xs text-slate-400">ไม่มีพนักงานในสาขานี้</div>
          ) : (
            // One column per branch, side by side on desktop (owner 2026-09-02:
            // ซ้าย นามะ ขวา อีเมีย); stacked to one column on mobile so names aren't
            // squeezed (owner 2026-09-02). Only branches that have staff are shown.
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
              {branches.filter((b) => staff.some((s) => s.branchId === b.id)).map((b) => {
                const list = staff.filter((s) => s.branchId === b.id);
                const allIn = list.every((s) => invited.has(s.id));
                return (
                  <div key={b.id} className="rounded-lg border border-[#EFE4D3] bg-white/60 p-2">
                    <div className="flex items-center justify-between px-1 pb-1.5 mb-1 border-b border-[#EFE4D3]">
                      <span className="text-sm font-semibold text-brand">{b.name}</span>
                      <button type="button" className="text-[11px] text-slate-500 hover:text-brand"
                        onClick={() => setInvited((prev) => {
                          const next = new Set(prev);
                          if (allIn) list.forEach((s) => next.delete(s.id));
                          else list.forEach((s) => next.add(s.id));
                          return next;
                        })}>
                        {allIn ? "ล้างสาขานี้" : "เลือกสาขานี้"}
                      </button>
                    </div>
                    <div className="space-y-2">
                      {groupByDept(list).map(({ dept, people }) => {
                        const allDept = people.every((s) => invited.has(s.id));
                        return (
                          <div key={dept}>
                            <div className="flex items-center justify-between px-1">
                              <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{dept}</span>
                              <button type="button" className="text-[10px] text-slate-400 hover:text-brand"
                                onClick={() => setInvited((prev) => {
                                  const next = new Set(prev);
                                  if (allDept) people.forEach((s) => next.delete(s.id));
                                  else people.forEach((s) => next.add(s.id));
                                  return next;
                                })}>
                                {allDept ? "ล้าง" : "เลือก"}
                              </button>
                            </div>
                            <div className="space-y-0.5">
                              {people.map((s) => (
                                <label key={s.id} className="flex items-center gap-2 text-sm text-slate-700 rounded px-2 py-1 hover:bg-slate-50 cursor-pointer">
                                  <input type="checkbox" checked={invited.has(s.id)} onChange={() => toggleInvite(s.id)} />
                                  <span>{s.title_prefix ? `${s.title_prefix} ` : ""}{s.display_name}</span>
                                  {s.fee_exempt && <span className="text-[10px] bg-violet-50 text-violet-600 border border-violet-200 rounded-full px-1.5">ยกเว้นเบี้ย</span>}
                                </label>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button type="button" onClick={create} disabled={busy} className="btn-primary text-sm disabled:opacity-50">
            {busy ? "..." : "สร้างการประชุม"}
          </button>
          {msg && <span className={`text-xs ${msg.kind === "ok" ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</span>}
        </div>
      </div>

      {/* List */}
      <div className="card">
        <div className="text-sm font-semibold text-slate-700 mb-2">การประชุมทั้งหมด</div>
        {meetings.length === 0 ? (
          <div className="text-sm text-slate-400 py-6 text-center">ยังไม่มีการประชุม</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b whitespace-nowrap">
                  <th className="py-2 pr-3">หัวข้อ</th>
                  <th className="py-2 pr-3">วันที่</th>
                  <th className="py-2 pr-3">สาขา</th>
                  <th className="py-2 pr-3">สถานะ</th>
                  <th className="py-2 pr-3">เชิญ / เข้าร่วม / จบ</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {meetings.map((m) => (
                  <tr key={m.id} className="border-b last:border-0 hover:bg-slate-50">
                    <td className="py-2 pr-3 font-medium text-slate-800">{m.title}</td>
                    <td className="py-2 pr-3 text-slate-600 whitespace-nowrap">{m.meeting_date}</td>
                    <td className="py-2 pr-3 text-slate-500">{m.branch_name ?? "ทั้งบริษัท"}</td>
                    <td className="py-2 pr-3">
                      <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${STATUS_STYLE[m.status]}`}>{STATUS_LABEL[m.status]}</span>
                    </td>
                    <td className="py-2 pr-3 text-slate-600 whitespace-nowrap tabular-nums">
                      {m.invitee_count} / {m.joined_count} / {m.ended_count}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-right">
                      {m.status === "scheduled" && (
                        <button type="button" onClick={() => setStatus(m.id, "active")} className="text-xs text-emerald-600 hover:underline mr-3">เปิดประชุม</button>
                      )}
                      {m.status === "active" && (
                        <button type="button" onClick={() => setStatus(m.id, "ended")} className="text-xs text-amber-600 hover:underline mr-3">ปิดประชุม</button>
                      )}
                      <button type="button" onClick={() => setDetailId(m.id)} className="text-xs text-brand hover:underline mr-3">รายละเอียด/สรุป</button>
                      <button type="button" onClick={() => remove(m.id)} className="text-xs text-rose-500 hover:underline">ลบ</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detailId != null && (
        <MeetingDetailModal meetingId={detailId} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}

type MinuteItem = { topic: string; details: string; suggestions: string; action_plan: string; owner_user_ids: number[] };
type Invitee = {
  user_id: number; display_name: string; title_prefix: string | null; fee_exempt: boolean;
  joined_at: string | null; ended_at: string | null; minutes: number | null; fee_amount: number | null;
  minutes_complete: boolean; items: MinuteItem[];
};
type Detail = {
  id: number; title: string; meeting_date: string; status: string;
  ai_summary: string | null; ai_checklist: string | null; ai_carryover: string | null; summarized_at: string | null;
  ai_in_tokens: number | null; ai_out_tokens: number | null; ai_cost_baht: number | null; ai_model: string | null;
  agenda_topics: string[];
  invitees: Invitee[];
};

function MeetingDetailModal({ meetingId, onClose }: { meetingId: number; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Editable preset วาระ — allowed until the meeting starts (owner 2026-09-02).
  const [topics, setTopics] = useState<string[]>([]);
  const [savingTopics, setSavingTopics] = useState(false);
  const [topicsMsg, setTopicsMsg] = useState<string | null>(null);

  async function load() {
    const res = await fetch(apiUrl(`/api/admin/persona/exec-meetings/${meetingId}`));
    const j = await res.json().catch(() => ({}));
    if (j?.meeting) { setD(j.meeting as Detail); setTopics((j.meeting as Detail).agenda_topics ?? []); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [meetingId]);

  async function saveTopics() {
    setSavingTopics(true); setTopicsMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/exec-meetings/${meetingId}`), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agenda_topics: topics.map((t) => t.trim()).filter(Boolean) })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) { setTopicsMsg("บันทึกวาระแล้ว"); await load(); }
      else setTopicsMsg(j?.error === "no_change" ? "ไม่มีการเปลี่ยนแปลง" : (j?.message ?? j?.error ?? "บันทึกไม่สำเร็จ"));
    } catch { setTopicsMsg("เชื่อมต่อไม่ได้"); }
    finally { setSavingTopics(false); }
  }

  async function summarize() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/exec-meetings/${meetingId}/summarize`), { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!j?.ok) { setErr(j?.message ?? j?.error ?? "สรุปไม่สำเร็จ"); return; }
      await load();
    } catch { setErr("เชื่อมต่อไม่ได้"); }
    finally { setBusy(false); }
  }

  const checklist: Array<{ item: string; owner?: string }> = (() => {
    try { return d?.ai_checklist ? JSON.parse(d.ai_checklist) : []; } catch { return []; }
  })();
  const carryover: Array<{ item: string }> = (() => {
    try { return d?.ai_carryover ? JSON.parse(d.ai_carryover) : []; } catch { return []; }
  })();
  const anyMinutes = (d?.invitees ?? []).some((i) => i.minutes_complete);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-y-auto p-4 sm:p-5"
        onClick={(e) => e.stopPropagation()}>
        {!d ? (
          <div className="py-10 text-center text-sm text-slate-400">กำลังโหลด...</div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-bold text-slate-800">{d.title}</div>
                <div className="text-xs text-slate-500">{d.meeting_date}</div>
              </div>
              <div className="flex items-center gap-3">
                <a href={apiUrl(`/api/admin/persona/exec-meetings/${meetingId}/pdf`)} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-brand hover:underline whitespace-nowrap">ดาวน์โหลด PDF</a>
                <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
              </div>
            </div>

            {/* Preset วาระ — editable until the meeting starts, read-only after. */}
            {d.status === "scheduled" ? (
              <div className="rounded-xl border border-[#EFE4D3] bg-[#faf5ec] p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-600">วาระที่กำหนด (แก้ไข/เพิ่มได้จนกว่าจะเปิดประชุม)</span>
                  <button type="button" className="text-xs text-brand hover:underline"
                    onClick={() => setTopics((prev) => [...prev, ""])}>+ เพิ่มวาระ</button>
                </div>
                {topics.length === 0 ? (
                  <div className="text-xs text-slate-400">ยังไม่ได้ตั้งวาระ — พนักงานจะเพิ่มวาระเองได้ตอนประชุม</div>
                ) : (
                  <div className="space-y-1.5">
                    {topics.map((t, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-xs text-slate-400 w-5 text-right tabular-nums">{i + 1}.</span>
                        <input className="input flex-1" value={t} placeholder="เช่น สรุปยอดขายสัปดาห์นี้"
                          onChange={(e) => setTopics((prev) => prev.map((x, idx) => (idx === i ? e.target.value : x)))} />
                        <button type="button" onClick={() => setTopics((prev) => prev.filter((_, idx) => idx !== i))}
                          className="text-rose-400 hover:text-rose-600 text-lg leading-none px-1">×</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-3 pt-1">
                  <button type="button" onClick={saveTopics} disabled={savingTopics}
                    className="btn-secondary text-xs disabled:opacity-50">
                    {savingTopics ? "..." : "บันทึกวาระ"}
                  </button>
                  {topicsMsg && <span className="text-xs text-slate-500">{topicsMsg}</span>}
                </div>
              </div>
            ) : d.agenda_topics.length > 0 ? (
              <div className="rounded-xl border border-[#EFE4D3] bg-[#faf5ec] p-3">
                <div className="text-xs font-semibold text-slate-600 mb-1">วาระที่กำหนด</div>
                <ol className="text-sm text-slate-700 list-decimal pl-5 space-y-0.5">
                  {d.agenda_topics.map((t, i) => <li key={i}>{t}</li>)}
                </ol>
              </div>
            ) : null}

            {/* Attendance + minutes status */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500 border-b whitespace-nowrap">
                    <th className="py-1.5 pr-2">ผู้ได้รับเชิญ</th>
                    <th className="py-1.5 px-2">เข้าร่วม</th>
                    <th className="py-1.5 px-2">รายงาน</th>
                    <th className="py-1.5 px-2 text-right">นาที</th>
                    <th className="py-1.5 pl-2 text-right">เบี้ยประชุม</th>
                  </tr>
                </thead>
                <tbody>
                  {d.invitees.map((i) => (
                    <tr key={i.user_id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2 text-slate-700">
                        {i.title_prefix ? `${i.title_prefix} ` : ""}{i.display_name}
                        {i.fee_exempt && <span className="ml-1 text-[10px] text-violet-600">(ยกเว้นเบี้ย)</span>}
                      </td>
                      <td className="py-1.5 px-2">{i.ended_at ? "จบแล้ว" : i.joined_at ? "กำลังประชุม" : "—"}</td>
                      <td className="py-1.5 px-2">{i.minutes_complete ? "ครบ" : i.joined_at ? "ยังไม่ครบ" : "—"}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{i.minutes ?? "—"}</td>
                      <td className="py-1.5 pl-2 text-right tabular-nums">{i.fee_amount != null ? `฿${i.fee_amount.toLocaleString("th-TH", { minimumFractionDigits: 2 })}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Submitted minutes per person, grouped by วาระ */}
            {d.invitees.some((i) => i.items.length > 0) && (
              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-700">รายงานการประชุม (รายคน)</div>
                {d.invitees.filter((i) => i.items.length > 0).map((i) => (
                  <details key={i.user_id} className="rounded-xl border border-slate-200 p-3">
                    <summary className="cursor-pointer text-sm font-medium text-slate-700">
                      {i.title_prefix ? `${i.title_prefix} ` : ""}{i.display_name}
                      <span className="text-xs text-slate-400"> · {i.items.length} วาระ</span>
                    </summary>
                    <div className="mt-2 space-y-3">
                      {i.items.map((it, j) => (
                        <div key={j} className="text-sm">
                          <div className="font-semibold text-brand">วาระที่ {j + 1}: {it.topic}</div>
                          <div className="text-slate-700 whitespace-pre-wrap"><span className="text-slate-400">รายละเอียด:</span> {it.details}</div>
                          <div className="text-slate-700 whitespace-pre-wrap"><span className="text-slate-400">ข้อเสนอแนะ:</span> {it.suggestions}</div>
                          <div className="text-slate-700 whitespace-pre-wrap"><span className="text-slate-400">แผนการจัดการ:</span> {it.action_plan}</div>
                          {it.owner_user_ids.length > 0 && (
                            <div className="text-slate-700"><span className="text-slate-400">ผู้รับผิดชอบ:</span> {it.owner_user_ids.map((uid) => ownerName(d.invitees, uid)).join(", ")}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}

            {/* AI summary */}
            <div className="rounded-xl border border-slate-200 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-slate-700">สรุปด้วย AI</div>
                <button type="button" onClick={summarize} disabled={busy || !anyMinutes}
                  title={!anyMinutes ? "ยังไม่มีรายงานให้สรุป" : undefined}
                  className="btn-secondary text-xs disabled:opacity-50">
                  {busy ? "กำลังสรุป..." : d.summarized_at ? "สรุปใหม่" : "สรุปด้วย AI"}
                </button>
              </div>
              {err && <div className="text-xs text-rose-600">{err}</div>}
              {d.ai_summary ? (
                <div className="space-y-3">
                  <div className="text-sm text-slate-700 whitespace-pre-wrap">{d.ai_summary}</div>
                  {checklist.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-slate-600 mb-1">เช็คลิสต์ติดตามสัปดาห์หน้า</div>
                      <ul className="text-sm text-slate-700 space-y-1">
                        {checklist.map((c, i) => (
                          <li key={i} className="flex gap-2"><span className="text-brand">☐</span><span>{c.item}{c.owner ? ` — ${c.owner}` : ""}</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {carryover.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-amber-700 mb-1">ประเด็นคงค้าง (ยกไปคุยสัปดาห์หน้า)</div>
                      <ul className="text-sm text-slate-700 space-y-1 list-disc pl-5">
                        {carryover.map((c, i) => <li key={i}>{c.item}</li>)}
                      </ul>
                    </div>
                  )}
                  {d.ai_cost_baht != null && (
                    <div className="text-[11px] text-slate-400 border-t border-slate-100 pt-2">
                      ใช้ AI · {(d.ai_in_tokens ?? 0).toLocaleString("th-TH")} + {(d.ai_out_tokens ?? 0).toLocaleString("th-TH")} tokens
                      {" · "}ประมาณ ฿{d.ai_cost_baht.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      {d.ai_model ? ` · ${d.ai_model}` : ""}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-slate-400">ยังไม่ได้สรุป — กด &quot;สรุปด้วย AI&quot; เมื่อผู้เข้าร่วมส่งรายงานแล้ว</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
