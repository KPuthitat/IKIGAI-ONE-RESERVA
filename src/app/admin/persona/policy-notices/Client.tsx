"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";
import { FormSection, Field } from "@/app/components/FormKit";
import EmptyState from "@/app/components/EmptyState";
import Mascot from "@/app/components/Mascot";
import { pdfToImages, PdfTooLong } from "@/lib/pdf-pages";
import { thaiMeetingTime } from "@/lib/policy-notices-notify";

type Status = "scheduled" | "published" | "closed" | "cancelled";
type Summary = { id: number; title: string; announcer: string; meetingAt: string | null; status: Status; branchName: string | null; recipientCount: number; ackedCount: number; publishedAt: string | null };
type Item = { topic: string; details: string; suggestions: string };
type Suggestion = { id: number; body: string; day: string };
type Ack = { userId: number; name: string; ackedAt: string | null; lastRemindedAt: string | null };
type Detail = {
  notice: { id: number; title: string; announcer: string; parentId: number | null; parentTitle: string | null; purpose: string; meetingAt: string | null; location: string; branchId: number | null; status: Status; ackDeadline: string | null; invitedAt: string | null };
  items: Item[]; images: Array<{ id: number }>; recipients: Ack[];
  suggestions: Suggestion[]; aiSummary: string | null; aiSummaryAt: string | null; followUps: Array<{ id: number; title: string; status: Status }>;
};
type Branch = { id: number; name: string };

const STATUS_TAG: Record<Status, { cls: string; label: string }> = {
  scheduled: { cls: "tag-info", label: "นัดประชุม" },
  published: { cls: "tag-warn", label: "รอรับทราบ" },
  closed: { cls: "tag-ok", label: "ปิดแล้ว" },
  cancelled: { cls: "tag-mute", label: "ยกเลิก" }
};
const MAX_UPLOAD = 10 * 1024 * 1024;   // the server refuses more; bigger pictures are re-encoded first
const KEEP_AS_IS = new Set(["image/png", "image/jpeg", "image/webp"]);

/** A picture the server will take: kept untouched when small enough, otherwise re-encoded as JPEG (long side ≤ 2400px). */
async function prepareImage(file: File): Promise<File | null> {
  if (KEEP_AS_IS.has(file.type) && file.size <= MAX_UPLOAD) return file;
  if (!file.type.startsWith("image/")) return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
    for (const [edge, q] of [[2400, 0.9], [2000, 0.8], [1600, 0.7]] as const) {
      const k = Math.min(1, edge / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", q));
      if (blob && blob.size <= MAX_UPLOAD) return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
    }
    return null;
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}
const blankItem = (): Item => ({ topic: "", details: "", suggestions: "" });
const fmtTime = (iso: string) => new Date(iso).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Bangkok" });

export default function Client() {
  const [list, setList] = useState<Summary[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [me, setMe] = useState("");
  const [openId, setOpenId] = useState<number | "new" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(async () => {
    const r = await fetch(apiUrl("/api/admin/persona/policy-notices"), { cache: "no-store" });
    if (r.ok) { const j = await r.json(); setList(j.notices); setBranches(j.branches); setMe(j.me ?? ""); }
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
        <Editor key={String(openId)} id={openId} branches={branches} me={me}
          onClose={() => { setOpenId(null); void reload(); }}
          onOpen={(nid) => { setMsg(null); setOpenId(nid); void reload(); }}
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
              {n.meetingAt ? thaiMeetingTime(n.meetingAt) : "ยังไม่กำหนดวันประชุม"} · {n.branchName ?? "ทุกสาขา"}{n.announcer ? ` · ประกาศโดย ${n.announcer}` : ""}
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

function Editor({ id, branches, me, onClose, onOpen, onMessage }: { id: number | "new"; branches: Branch[]; me: string; onClose: () => void; onOpen: (id: number) => void; onMessage: (m: { ok: boolean; text: string }) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [title, setTitle] = useState("");
  const [announcer, setAnnouncer] = useState(me);
  const [purpose, setPurpose] = useState("");
  const [meetingAt, setMeetingAt] = useState("");
  const [location, setLocation] = useState("");
  const [branchId, setBranchId] = useState<string>("");
  const [deadline, setDeadline] = useState("");
  const [items, setItems] = useState<Item[]>([blankItem()]);
  const [images, setImages] = useState<Array<{ id: number }>>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fill = useCallback((d: Detail) => {
    setDetail(d);
    setTitle(d.notice.title); setAnnouncer(d.notice.announcer); setPurpose(d.notice.purpose); setMeetingAt(d.notice.meetingAt ?? "");
    setLocation(d.notice.location); setBranchId(d.notice.branchId ? String(d.notice.branchId) : ""); setDeadline(d.notice.ackDeadline ?? "");
    setItems(d.items.length ? d.items : [blankItem()]);
    setImages(d.images ?? []);
  }, []);
  const load = useCallback(async (nid: number) => {
    const r = await fetch(apiUrl(`/api/admin/persona/policy-notices/${nid}`), { cache: "no-store" });
    if (r.ok) fill(await r.json());
  }, [fill]);
  useEffect(() => { if (id !== "new") void load(id); }, [id, load]);

  const status: Status = detail?.notice.status ?? "scheduled";
  const locked = status !== "scheduled";
  const fields = () => ({ title, announcer, purpose, meeting_at: meetingAt || null, location, branch_id: branchId ? Number(branchId) : null, ack_deadline: deadline || null });

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
  async function addImages(files: File[]) {
    if (files.length === 0) return;
    setBusy(true); setErr(null);
    try {
      const nid = id === "new" ? await save() : id;   // a new notice needs to exist before pictures can hang off it
      if (nid == null) return;
      // A PDF becomes one picture per page, so everything is read the same way on a phone.
      let room = 10 - images.length;
      for (const f of files) {
        let parts: File[] = [];
        if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
          try { parts = await pdfToImages(f, room); }
          catch (e) { setErr(e instanceof PdfTooLong ? `ไฟล์ “${f.name}” มี ${e.pages} หน้า แนบได้อีก ${room} รูปเท่านั้น` : `เปิดไฟล์ PDF “${f.name}” ไม่ได้`); break; }
        } else {
          const one = await prepareImage(f);
          if (!one) { setErr(`ใช้ไฟล์ “${f.name}” ไม่ได้ (รองรับ PNG / JPG / WebP / PDF)`); break; }
          parts = [one];
        }
        if (parts.length > room) { setErr(`แนบได้ไม่เกิน 10 รูป`); break; }
        let failed = false;
        for (const part of parts) {
          const fd = new FormData(); fd.append("file", part);
          const r = await fetch(apiUrl(`/api/admin/persona/policy-notices/${nid}/images`), { method: "POST", body: fd });
          if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(String(j.message ?? "อัปโหลดรูปไม่สำเร็จ")); failed = true; break; }
          room--;
        }
        if (failed) break;
      }
      await load(nid);
    } finally { setBusy(false); }
  }
  async function removeImage(imageId: number) {
    if (id === "new" || !window.confirm("ลบรูปนี้?")) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(apiUrl(`/api/admin/persona/policy-notices/${id}/images?image=${imageId}`), { method: "DELETE" });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(String(j.message ?? "ลบรูปไม่สำเร็จ")); return; }
      await load(id);
    } finally { setBusy(false); }
  }
  async function summarize() {
    if (id === "new") return;
    setAiBusy(true); setErr(null);
    try {
      const r = await call(`/api/admin/persona/policy-notices/${id}/summary`, "POST", {});
      if (!r.ok) { setErr(String(r.j.message ?? "สรุปไม่สำเร็จ")); return; }
      await load(id);
    } finally { setAiBusy(false); }
  }
  async function followUp() {
    if (id === "new" || !window.confirm("สร้างประกาศฉบับแก้ไขต่อจากฉบับนี้?")) return;
    setBusy(true); setErr(null);
    try {
      const r = await call(`/api/admin/persona/policy-notices/${id}/follow-up`, "POST", {});
      if (!r.ok) { setErr(String(r.j.message ?? "สร้างไม่สำเร็จ")); return; }
      onOpen(Number(r.j.id));
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

      {detail?.notice.parentId && <div className="rounded-2xl bg-brand/10 px-3 py-2 text-sm text-brand">ฉบับแก้ไข สืบเนื่องจาก “{detail.notice.parentTitle}” — พนักงานจะเห็นว่าประกาศนี้ต่อจากฉบับเดิม</div>}
      <FormSection title="1. นัดประชุม">
        <Field label="ชื่อเรื่อง"><input value={title} onChange={(e) => setTitle(e.target.value)} disabled={locked} placeholder="เช่น ตำแหน่งงานที่มีค่าตอบแทนพิเศษ" /></Field>
        <Field label="ผู้ประกาศ" hint="แสดงให้พนักงานเห็นว่าประกาศโดยใคร"><input value={announcer} onChange={(e) => setAnnouncer(e.target.value)} disabled={locked} /></Field>
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

      <FormSection title={`2. หนังสือแจ้งหลังประชุม (${items.filter((i) => i.topic.trim()).length} หัวข้อ · ${images.length} รูป)`}>
        <div className="space-y-2">
          <div className="text-sm font-bold text-slate-700">รูปภาพประกอบ <span className="font-normal text-slate-500">(เช่น infographic · ไฟล์ JPG / PNG / PDF · ไม่บังคับ · ได้ไม่เกิน 10 รูป)</span></div>
          {images.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {images.map((im, i) => (
                <div key={im.id} className="relative rounded-xl border border-[color:var(--card-border)] overflow-hidden bg-[color:var(--surface-field)]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={apiUrl(`/api/policy-notices/image/${im.id}`)} alt={`รูปที่ ${i + 1}`} className="w-full h-40 object-contain" />
                  {!locked && <button type="button" className="absolute right-1 top-1 rounded-full bg-white/90 px-2 py-0.5 text-xs text-rose-600 shadow" onClick={() => void removeImage(im.id)} disabled={busy}>ลบ</button>}
                </div>
              ))}
            </div>
          )}
          {!locked && images.length < 10 && (
            <label className="btn btn-secondary text-sm cursor-pointer inline-flex">
              + แนบรูป / ไฟล์ PDF
              <input type="file" accept="image/*,application/pdf" multiple className="hidden" disabled={busy || !title.trim()} onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ""; void addImages(picked); }} />
            </label>
          )}
          {!locked && !title.trim() && <p className="text-xs text-slate-500">ใส่ชื่อเรื่องก่อน จึงจะแนบรูปได้</p>}
          {!locked && <p className="text-xs text-slate-500">รูปจะแสดงให้พนักงานอ่านต่อจากวัตถุประสงค์ ก่อนหัวข้อต่างๆ รูปใหญ่เกิน 10 MB ระบบย่อให้อัตโนมัติ · ไฟล์ PDF ระบบแปลงแต่ละหน้าเป็นรูปให้</p>}
        </div>
        <p className="text-xs text-slate-500">กรอกหลังประชุมเสร็จ — พนักงานอ่านแล้วกดรับทราบ และเขียนข้อเสนอแนะแบบไม่ระบุชื่อได้ตอนกดรับทราบ (ดูผลที่หัวข้อ “ข้อเสนอแนะจากพนักงาน” ด้านล่างหลังส่งหนังสือ)</p>
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
            {detail?.notice.parentId ? <Field label="ข้อเสนอแนะที่ได้รับ และการพิจารณาของฝ่ายบริหาร" hint="ยกมาเฉพาะที่ต้องการตอบ · ไม่ต้องใส่ชื่อ · ถ้ามี"><textarea rows={3} value={it.suggestions} onChange={(e) => setItem(i, { suggestions: e.target.value })} disabled={locked} /></Field> : null}
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
          <button type="button" className="btn btn-primary" disabled={busy || !title.trim() || !(images.length > 0 || items.some((i) => i.topic.trim() && i.details.trim()))}
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

      {detail && (status === "published" || status === "closed") && (
        <FormSection title={`4. ข้อเสนอแนะจากพนักงาน (${detail.suggestions.length} ข้อ · ไม่ระบุชื่อ)`}>
          {detail.suggestions.length === 0 ? <p className="text-sm text-slate-500">ยังไม่มีข้อเสนอแนะ พนักงานเขียนได้ตอนกดรับทราบ</p> : (
            <>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-primary text-sm" disabled={aiBusy} onClick={() => void summarize()}>{aiBusy ? "AI กำลังสรุป…" : detail.aiSummary ? "ให้ AI สรุปใหม่" : "ให้ AI สรุป"}</button>
              </div>
              {detail.aiSummary && (
                <div className="rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--surface-field)] p-3">
                  <div className="text-[11px] font-bold text-slate-500 mb-1">สรุปโดย AI{detail.aiSummaryAt ? ` · ${fmtTime(detail.aiSummaryAt)}` : ""}</div>
                  <Markdownish text={detail.aiSummary} />
                </div>
              )}
              <details className="rounded-2xl border border-[color:var(--card-border)]">
                <summary className="cursor-pointer px-3 py-2 text-sm font-bold text-slate-700">ข้อความดิบทั้งหมด ({detail.suggestions.length})</summary>
                <ul className="divide-y divide-[color:var(--card-border)] text-sm">
                  {detail.suggestions.map((x) => <li key={x.id} className="px-3 py-2 whitespace-pre-line text-slate-700">{x.body}</li>)}
                </ul>
              </details>
            </>
          )}
          <div className="border-t border-[color:var(--card-border)] pt-3 space-y-2">
            <p className="text-xs text-slate-500">เมื่อทีมบริหารพิจารณาแล้วมีการปรับเปลี่ยน ให้ทำประกาศฉบับแก้ไขต่อจากฉบับนี้ ยกเฉพาะข้อเสนอที่ต้องการตอบมาใส่ได้</p>
            <button type="button" className="btn btn-secondary text-sm" disabled={busy} onClick={() => void followUp()}>+ สร้างประกาศฉบับแก้ไข</button>
            {detail.followUps.length > 0 && (
              <div className="text-sm space-y-1">
                <div className="text-xs font-bold text-slate-500">ฉบับแก้ไขที่มีแล้ว</div>
                {detail.followUps.map((f) => <button key={f.id} type="button" className="block text-left text-brand hover:underline" onClick={() => onOpen(f.id)}>{f.title} · {STATUS_TAG[f.status].label}</button>)}
              </div>
            )}
          </div>
        </FormSection>
      )}
    </div>
  );
}

/** Minimal rendering of the AI digest: ### / #### headings, "- " bullets, paragraphs. */
function Markdownish({ text }: { text: string }) {
  return (
    <div className="text-sm text-slate-700 space-y-1">
      {text.split(/\r?\n/).map((l, i) => {
        const line = l.trimEnd();
        if (!line.trim()) return null;
        if (line.startsWith("####")) return <div key={i} className="font-bold text-slate-800 pt-1">{line.replace(/^#+\s*/, "")}</div>;
        if (line.startsWith("#")) return <div key={i} className="font-bold text-slate-800 pt-2 border-t border-[color:var(--card-border)] mt-2">{line.replace(/^#+\s*/, "")}</div>;
        if (/^\s*[-*•]\s+/.test(line)) return <div key={i} className="pl-3">• {line.replace(/^\s*[-*•]\s+/, "").replace(/\*\*/g, "")}</div>;
        return <div key={i}>{line.replace(/\*\*/g, "")}</div>;
      })}
    </div>
  );
}
