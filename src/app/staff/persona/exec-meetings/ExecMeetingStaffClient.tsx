"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

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
  minutes_form: { agenda: string; details: string; suggestions: string; action_plan: string };
  minutes_complete: boolean;
};

const FIELDS: Array<{ key: keyof StaffMeetingView["minutes_form"]; label: string; placeholder: string }> = [
  { key: "agenda", label: "วาระ", placeholder: "หัวข้อ/วาระที่ประชุม" },
  { key: "details", label: "รายละเอียด", placeholder: "สาระสำคัญที่คุยกัน" },
  { key: "suggestions", label: "ข้อเสนอแนะ", placeholder: "สิ่งที่เสนอ/ความเห็น" },
  { key: "action_plan", label: "แผนการจัดการ", placeholder: "จะทำอะไรต่อ ใครรับผิดชอบ เมื่อไร" }
];

function fmtMoney(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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
  const [form, setForm] = useState(m.minutes_form);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const complete = FIELDS.every((f) => form[f.key].trim().length > 0);
  const joined = m.joined_at != null;
  const ended = m.ended_at != null;

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
    if (await post({ action: "minutes", ...form }, "minutes")) setMsg({ kind: "ok", text: "บันทึกรายงานแล้ว" });
  }
  async function end() {
    // Persist the latest minutes first so a just-typed field isn't lost.
    const saved = await post({ action: "minutes", ...form }, "end");
    if (!saved) return;
    const done = await post({ action: "end" }, "end");
    if (done) { setMsg({ kind: "ok", text: `สิ้นสุดการประชุม · ${done.minutes} นาที · เบี้ยประชุม ฿${fmtMoney(Number(done.fee) || 0)}` }); onChanged(); }
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold text-slate-800">{m.title}</div>
          <div className="text-xs text-slate-500">{m.meeting_date}</div>
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
          <div className="text-xs text-slate-500">กรอกรายงานการประชุมให้ครบทั้ง 4 ช่องก่อนสิ้นสุดการประชุม</div>
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label className="label">{f.label}{form[f.key].trim() ? "" : <span className="text-rose-400"> *</span>}</label>
              <textarea className="input min-h-[64px]" value={form[f.key]} placeholder={f.placeholder}
                onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))} />
            </div>
          ))}
          <div className="flex items-center gap-3">
            <button type="button" onClick={saveMinutes} disabled={busy != null} className="btn-secondary text-sm disabled:opacity-50">
              {busy === "minutes" ? "..." : "บันทึกรายงาน"}
            </button>
            <button type="button" onClick={end} disabled={busy != null || !complete}
              title={!complete ? "กรอกให้ครบ 4 ช่องก่อน" : undefined}
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

function StatusBadge({ status, joined, ended }: { status: string; joined: boolean; ended: boolean }) {
  const [label, style] = ended
    ? ["จบแล้ว", "bg-slate-100 text-slate-500"]
    : joined
    ? ["กำลังเข้าร่วม", "bg-emerald-100 text-emerald-700"]
    : status === "active"
    ? ["เปิดให้เข้าร่วม", "bg-amber-100 text-amber-700"]
    : ["ยังไม่เปิด", "bg-slate-100 text-slate-500"];
  return <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${style}`}>{label}</span>;
}
