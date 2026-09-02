"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

export type StaffLite = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  fee_exempt: boolean;
};

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

function bkkToday(): string {
  const now = new Date();
  const bkk = new Date(now.getTime() + (now.getTimezoneOffset() + 420) * 60000);
  return bkk.toISOString().slice(0, 10);
}

export default function ExecMeetingsClient({ staff, meetings }: { staff: StaffLite[]; meetings: MeetingRow[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [title, setTitle] = useState("");
  const [date, setDate] = useState(bkkToday());
  const [companyWide, setCompanyWide] = useState(false);
  const [invited, setInvited] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

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
          invitee_user_ids: Array.from(invited)
        })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        setTitle(""); setInvited(new Set()); setCompanyWide(false);
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
            <div className="grid gap-1.5 sm:grid-cols-2 max-h-64 overflow-y-auto">
              {staff.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm text-slate-700 rounded px-2 py-1 hover:bg-slate-50">
                  <input type="checkbox" checked={invited.has(s.id)} onChange={() => toggleInvite(s.id)} />
                  <span>{s.title_prefix ? `${s.title_prefix} ` : ""}{s.display_name}</span>
                  {s.fee_exempt && <span className="text-[10px] bg-violet-50 text-violet-600 border border-violet-200 rounded-full px-1.5">ยกเว้นเบี้ย</span>}
                </label>
              ))}
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
                      <button type="button" onClick={() => remove(m.id)} className="text-xs text-rose-500 hover:underline">ลบ</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
