"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";
import { FormSection, Field } from "@/app/components/FormKit";
import EmptyState from "@/app/components/EmptyState";
import Mascot from "@/app/components/Mascot";
import { thaiMeetingTime } from "@/lib/policy-notices-notify";

type Status = "scheduled" | "published" | "closed" | "cancelled";
type Summary = { id: number; title: string; meetingAt: string | null; status: Status; branchName: string | null; recipientCount: number; ackedCount: number; publishedAt: string | null };
type Item = { topic: string; details: string; suggestions: string };
type Ack = { userId: number; name: string; ackedAt: string | null; lastRemindedAt: string | null };
type Detail = {
  notice: { id: number; title: string; purpose: string; meetingAt: string | null; location: string; branchId: number | null; status: Status; ackDeadline: string | null; invitedAt: string | null };
  items: Item[]; recipients: Ack[];
};
type Branch = { id: number; name: string };

const STATUS_TAG: Record<Status, { cls: string; label: string }> = {
  scheduled: { cls: "tag-info", label: "นัดประชุม" },
  published: { cls: "tag-warn", label: "รอรับทราบ" },
  closed: { cls: "tag-ok", label: "ปิดแล้ว" },
  cancelled: { cls: "tag-mute", label: "ยกเลิก" }
};
const blankItem = (): Item => ({ topic: "", details: "", suggestions: "" });
const fmtTime = (iso: string) => new Date(iso).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Bangkok" });

export default function Client() {
  const [list, setList] = useState<Summary[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [openId, setOpenId] = useState<number | "new" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(async () => {
    const r = await fetch(apiUrl("/api/admin/persona/policy-notices"), { cache: "no-store" });
    if (r.ok) { const j = await r.json(); setList(j.notices); setBranches(j.branches); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Mascot pose="notes" size={72} className="flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-slate-800">ประกาศนโยบาย</h1>
          <p className="text-sm text-slate-500">นัดประชุมพนักงาน แล้วส่งหนังสือสรุปหลังประชุมให้พนักงานกดรับทราบ</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => { setMsg(null); setOpenId("new"); }}>+ สร้างใหม่</button>
      </div>

      {msg && <div className={`card text-sm ${msg.ok ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</div>}

      {openId != null && (
        <Editor key={String(openId)} id={openId} branches={branches}
          onClose={() => { setOpenId(null); void reload(); }}
          onMessage={(m) => { setMsg(m); void reload(); }} />
      )}

      <div className="space-y-2">
        {list.length === 0 && <EmptyState>ยังไม่มีประกาศ — กด “+ สร้างใหม่” เมื่อมีนัดประชุม</EmptyState>}
        {list.map((n) => (
          <button key={n.id} type="button" onClick={() => { setMsg(null); setOpenId(n.id); }}
            className="card w-full text-left hover:shadow-card-lg transition p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="font-bold text-slate-800 truncate">{n.title}</div>
              <span className={`tag ${STATUS_TAG[n.status].cls}`}>{STATUS_TAG[n.status].label}</span>
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {n.meetingAt ? thaiMeetingTime(n.meetingAt) : "ยังไม่กำหนดวันประชุม"} · {n.branchName ?? "ทุกสาขา"}
            </div>
            {n.status !== "scheduled" && n.status !== "cancelled" && (
              <div className="mt-2">
                <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full bg-brand" style={{ width: `${n.recipientCount ? Math.round((n.ackedCount / n.recipientCount) * 100) : 0}%` }} />
                </div>
                <div className="text-[11px] text-slate-500 mt-1">รับทราบแล้ว {n.ackedCount} / {n.recipientCount} คน</div>
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function Editor({ id, branches, onClose, onMessage }: { id: number | "new"; branches: Branch[]; onClose: () => void; onMessage: (m: { ok: boolean; text: string }) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [meetingAt, setMeetingAt] = useState("");
  const [location, setLocation] = useState("");
  const [branchId, setBranchId] = useState<string>("");
  const [deadline, setDeadline] = useState("");
  const [items, setItems] = useState<Item[]>([blankItem()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fill = useCallback((d: Detail) => {
    setDetail(d);
    setTitle(d.notice.title); setPurpose(d.notice.purpose); setMeetingAt(d.notice.meetingAt ?? "");
    setLocation(d.notice.location); setBranchId(d.notice.branchId ? String(d.notice.branchId) : ""); setDeadline(d.notice.ackDeadline ?? "");
    setItems(d.items.length ? d.items : [blankItem()]);
  }, []);
  const load = useCallback(async (nid: number) => {
    const r = await fetch(apiUrl(`/api/admin/persona/policy-notices/${nid}`), { cache: "no-store" });
    if (r.ok) fill(await r.json());
  }, [fill]);
  useEffect(() => { if (id !== "new") void load(id); }, [id, load]);

  const status: Status = detail?.notice.status ?? "scheduled";
  const locked = status !== "scheduled";
  const fields = () => ({ title, purpose, meeting_at: meetingAt || null, location, branch_id: branchId ? Number(branchId) : null, ack_deadline: deadline || null });

  async function call(url: string, method: string, body: unknown): Promise<{ ok: boolean; j: Record<string, unknown> }> {
    const r = await fetch(apiUrl(url), { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, j };
  }
  async function save(): Promise<number | null> {
    setBusy(true); setErr(null);
    try {
      let nid = id === "new" ? null : id;
      if (nid == null) {
        const c = await call("/api/admin/persona/policy-notices", "POST", fields());
        if (!c.ok) { setErr(String(c.j.message ?? "บันทึกไม่สำเร็จ")); return null; }
        nid = Number(c.j.id);
      }
      const s = await call(`/api/admin/persona/policy-notices/${nid}`, "PUT", { ...fields(), items: items.filter((i) => i.topic.trim() || i.details.trim()) });
      if (!s.ok) { setErr(String(s.j.message ?? "บันทึกไม่สำเร็จ")); return null; }
      await load(nid);
      return nid;
    } finally { setBusy(false); }
  }
  async function act(action: "invite" | "publish" | "remind" | "close" | "cancel", confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setErr(null);
    try {
      // Always save first so what is sent is exactly what is on screen.
      let nid = id === "new" ? null : id;
      if (!locked && (action === "invite" || action === "publish" || nid == null)) { nid = await save(); if (nid == null) return; }
      const r = await call(`/api/admin/persona/policy-notices/${nid}/action`, "POST", { action });
      if (!r.ok) { setErr(String(r.j.message ?? "ทำรายการไม่สำเร็จ")); return; }
      const sent = Number(r.j.pushed ?? 0), total = Number(r.j.recipients ?? 0), noLine = Number(r.j.noLine ?? 0);
      const labels = { invite: "ส่งประกาศนัดประชุมแล้ว", publish: "ส่งหนังสือให้พนักงานรับทราบแล้ว", remind: "ส่งเตือนแล้ว", close: "ปิดการรับทราบแล้ว", cancel: "ยกเลิกแล้ว" } as const;
      onMessage({ ok: true, text: `${labels[action]}${total ? ` · ส่ง LINE ${sent}/${total} คน${noLine ? ` (ไม่มี LINE ${noLine} คน — พนักงานยังเห็นในระบบ)` : ""}` : ""}` });
      if (action === "close" || action === "cancel") onClose(); else await load(nid!);
    } finally { setBusy(false); }
  }
  const setItem = (i: number, patch: Partial<Item>) => setItems((arr) => arr.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) => setItems((arr) => { const j = i + d; if (j < 0 || j >= arr.length) return arr; const c = arr.slice(); [c[i], c[j]] = [c[j], c[i]]; return c; });

  const acked = detail?.recipients.filter((r) => r.ackedAt).length ?? 0;
  const total = detail?.recipients.length ?? 0;

  return (
    <div className="card space-y-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold text-slate-800">{id === "new" ? "ประกาศใหม่" : "แก้ไขประกาศ"}</h2>
        <div className="flex items-center gap-2">
          {detail && <span className={`tag ${STATUS_TAG[status].cls}`}>{STATUS_TAG[status].label}</span>}
          <button type="button" className="btn btn-secondary text-sm" onClick={onClose}>ปิด</button>
        </div>
      </div>

      <FormSection title="1. นัดประชุม">
        <Field label="ชื่อเรื่อง"><input value={title} onChange={(e) => setTitle(e.target.value)} disabled={locked} placeholder="เช่น ตำแหน่งงานที่มีค่าตอบแทนพิเศษ" /></Field>
        <Field label="วัตถุประสงค์ / ที่มา" hint="ถ้ามี"><textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} disabled={locked} /></Field>
        <div className="grid sm:grid-cols-2 gap-2.5">
          <Field label="วันเวลาประชุม"><input type="datetime-local" value={meetingAt} onChange={(e) => setMeetingAt(e.target.value)} disabled={locked} /></Field>
          <Field label="สถานที่" hint="ถ้ามี"><input value={location} onChange={(e) => setLocation(e.target.value)} disabled={locked} /></Field>
          <Field label="ส่งถึง">
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} disabled={locked}>
              <option value="">พนักงานทุกสาขา</option>
              {branches.map((b) => <option key={b.id} value={b.id}>เฉพาะสาขา {b.name}</option>)}
            </select>
          </Field>
          <Field label="ให้กดรับทราบภายใน" hint="ถ้ามี"><input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} disabled={locked} /></Field>
        </div>
      </FormSection>

      <FormSection title={`2. หนังสือแจ้งหลังประชุม (${items.filter((i) => i.topic.trim()).length} หัวข้อ)`}>
        <p className="text-xs text-slate-500">กรอกหลังประชุมเสร็จ — หนังสือจะส่งให้พนักงานกดรับทราบเท่านั้น (ไม่มีช่องให้พนักงานตอบ) ไม่ต้องใส่ชื่อผู้เสนอในช่องข้อเสนอแนะ</p>
        {items.map((it, i) => (
          <div key={i} className="rounded-2xl border border-[color:var(--card-border)] p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="tag tag-brand">หัวข้อที่ {i + 1}</span>
              {!locked && (
                <div className="flex items-center gap-2 text-xs">
                  <button type="button" className="text-slate-500 hover:text-brand" onClick={() => move(i, -1)} disabled={i === 0}>▲</button>
                  <button type="button" className="text-slate-500 hover:text-brand" onClick={() => move(i, 1)} disabled={i === items.length - 1}>▼</button>
                  <button type="button" className="text-rose-500 hover:underline" onClick={() => setItems((a) => (a.length > 1 ? a.filter((_, k) => k !== i) : [blankItem()]))}>ลบ</button>
                </div>
              )}
            </div>
            <Field label="หัวข้อ"><input value={it.topic} onChange={(e) => setItem(i, { topic: e.target.value })} disabled={locked} /></Field>
            <Field label="รายละเอียด"><textarea rows={4} value={it.details} onChange={(e) => setItem(i, { details: e.target.value })} disabled={locked} /></Field>
            <Field label="ข้อเสนอแนะจากพนักงาน" hint="สรุปที่ได้จากที่ประชุม · ถ้ามี"><textarea rows={3} value={it.suggestions} onChange={(e) => setItem(i, { suggestions: e.target.value })} disabled={locked} /></Field>
          </div>
        ))}
        {!locked && items.length < 30 && <button type="button" className="btn btn-secondary text-sm" onClick={() => setItems((a) => [...a, blankItem()])}>+ เพิ่มหัวข้อ</button>}
        {locked && <p className="text-xs text-amber-700">ส่งหนังสือไปแล้ว — เนื้อหาถูกล็อก เพื่อให้ทุกคนรับทราบข้อความเดียวกัน</p>}
      </FormSection>

      {err && <div className="text-sm text-rose-600">{err}</div>}

      {!locked && (
        <div className="flex flex-wrap gap-2 border-t border-[color:var(--card-border)] pt-3">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void save().then((n) => { if (n) onMessage({ ok: true, text: "บันทึกแล้ว" }); })}>บันทึก</button>
          <button type="button" className="btn btn-secondary" disabled={busy || !meetingAt || !title.trim()}
            onClick={() => void act("invite", "ส่งประกาศนัดประชุมให้พนักงานทางไลน์ตอนนี้เลยไหม")}>ส่งประกาศนัดประชุม</button>
          <button type="button" className="btn btn-primary" disabled={busy || !title.trim() || !items.some((i) => i.topic.trim() && i.details.trim())}
            onClick={() => void act("publish", "ส่งหนังสือให้พนักงานกดรับทราบ? ส่งแล้วแก้เนื้อหาไม่ได้")}>ส่งหนังสือให้รับทราบ</button>
          {detail && <button type="button" className="text-sm text-rose-500 hover:underline ml-auto" disabled={busy} onClick={() => void act("cancel", "ยกเลิกประกาศนี้?")}>ยกเลิกประกาศ</button>}
        </div>
      )}

      {detail && (status === "published" || status === "closed") && (
        <FormSection title={`3. การรับทราบ (${acked}/${total} คน)`}>
          <div className="flex flex-wrap gap-2">
            {status === "published" && <button type="button" className="btn btn-primary text-sm" disabled={busy || acked === total}
              onClick={() => void act("remind", "ส่งเตือนทางไลน์ถึงคนที่ยังไม่รับทราบ?")}>เตือนคนที่ยังไม่รับทราบ</button>}
            {status === "published" && <button type="button" className="btn btn-secondary text-sm" disabled={busy}
              onClick={() => void act("close", "ปิดการรับทราบ? หลังปิดพนักงานกดรับทราบไม่ได้แล้ว")}>ปิดการรับทราบ</button>}
          </div>
          <div className="rounded-2xl border border-[color:var(--card-border)] divide-y divide-[color:var(--card-border)]">
            {detail.recipients.map((r) => (
              <div key={r.userId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="text-slate-800">{r.name}</span>
                {r.ackedAt
                  ? <span className="tag tag-ok">รับทราบ {fmtTime(r.ackedAt)}</span>
                  : <span className="tag tag-warn">ยังไม่รับทราบ{r.lastRemindedAt ? ` · เตือนล่าสุด ${fmtTime(r.lastRemindedAt)}` : ""}</span>}
              </div>
            ))}
          </div>
        </FormSection>
      )}
    </div>
  );
}
