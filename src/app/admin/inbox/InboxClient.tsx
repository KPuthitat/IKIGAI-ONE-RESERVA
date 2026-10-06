"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiUrl } from "@/lib/url";
import { formatBkkDateTime } from "@/lib/time";
import OwlMascot from "@/app/components/OwlMascot";

const channelLabel = (ch: string) => ch === "facebook" ? "Facebook" : "LINE";

// Shapes mirror src/lib/inbox.ts (kept in sync by hand — small + stable).
type Conversation = {
  id: number;
  channel: string;
  channel_code: string;
  branch_id: number | null;
  branch_name: string | null;
  external_user_id: string;
  display_name: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread: number;
  status: string;
};
type Message = {
  id: number;
  direction: "in" | "out";
  body: string;
  sent_by: number | null;
  sent_by_name: string | null;
  media_kind?: "image" | "sticker" | null;
  media_ref?: string | null;
  created_at: string;
};

const POLL_MS = 15_000;

/** An inbound image, fetched on-demand from LINE. Falls back to the text label
 *  (e.g. "[รูปภาพ]") if the content has expired from LINE and the endpoint 404s. */
function InboxImage({ id, fallback }: { id: number; fallback: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="text-slate-500 italic">{fallback} <span className="text-[10px]">(รูปหมดอายุ)</span></div>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={apiUrl(`/api/admin/inbox/media/${id}`)} alt="รูปภาพ"
      className="max-w-[220px] max-h-[280px] rounded-lg object-contain" loading="lazy"
      onError={() => setFailed(true)} />
  );
}

/** Customer's shown name: the LINE display name, else a short id tail. */
function convName(c: Conversation): string {
  if (c.display_name) return c.display_name;
  const tail = c.external_user_id.slice(-6);
  return `ลูกค้า …${tail}`;
}

export default function InboxClient({
  initialConversations,
  hasAccess
}: {
  initialConversations: Conversation[];
  hasAccess: boolean;
}) {
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Branch filter (owner 2026-10-06): a viewer who can see several branches can
  // narrow the list to one. null = every branch. Remembered per browser.
  const [branchFilter, setBranchFilter] = useState<number | "none" | null>(null);
  useEffect(() => {
    // Read after mount so the server-rendered HTML and the first client render match.
    try {
      const v = window.localStorage.getItem("inboxBranchFilter");
      setBranchFilter(v === "none" ? "none" : v && /^\d+$/.test(v) ? Number(v) : null);
    } catch { /* ignore */ }
  }, []);
  const pickBranch = (b: number | "none" | null) => {
    setBranchFilter(b);
    try { window.localStorage.setItem("inboxBranchFilter", b == null ? "" : String(b)); } catch { /* ignore */ }
  };
  // Branches present in the loaded conversations, with each one's unread count.
  const branchChips = useMemo(() => {
    const m = new Map<number | "none", { key: number | "none"; name: string; unread: number }>();
    for (const c of conversations) {
      const key = c.branch_id ?? "none";
      const cur = m.get(key) ?? { key, name: c.branch_name ?? "ไม่ระบุสาขา", unread: 0 };
      if (c.unread) cur.unread++;
      m.set(key, cur);
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name, "th"));
  }, [conversations]);
  // A saved filter whose branch has no chats (or the viewer lost) must not hide everything.
  const activeBranch = branchFilter != null && branchChips.some((b) => b.key === branchFilter) ? branchFilter : null;
  const visibleConversations = useMemo(
    () => activeBranch == null ? conversations : conversations.filter((c) => (c.branch_id ?? "none") === activeBranch),
    [conversations, activeBranch]
  );

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId]
  );
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // The conversation currently open on screen — used to discard a late thread
  // fetch that resolves after the user has already switched away (otherwise a
  // slow response would render the wrong customer under the open header/reply).
  const openIdRef = useRef<number | null>(null);
  useEffect(() => { openIdRef.current = selectedId; }, [selectedId]);

  // Nudge the owl (HookFab) to re-pull its unread badge right away instead of
  // waiting for its own 60s poll, so reading/replying clears the badge live.
  function notifyBadge() {
    try { window.dispatchEvent(new CustomEvent("ikigai:inbox-read")); } catch { /* SSR / no window */ }
  }

  const refreshList = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(`/api/admin/inbox?status=${showAll ? "all" : "open"}`), { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      if (j.ok) setConversations(j.conversations as Conversation[]);
    } catch { /* offline — keep what we have */ }
  }, [showAll]);

  const loadThread = useCallback(async (id: number, opts: { markLocalRead?: boolean } = {}) => {
    try {
      const res = await fetch(apiUrl(`/api/admin/inbox?id=${id}`), { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      // Discard a response for a conversation the user has since switched away
      // from — otherwise it would overwrite the now-open thread's messages.
      if (openIdRef.current !== id) return;
      if (j.ok) {
        setMessages(j.messages as Message[]);
        if (opts.markLocalRead) {
          // The GET marked it read server-side; reflect that in the list + owl.
          setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
          notifyBadge();
        }
      }
    } catch { /* offline */ }
  }, []);

  function openConversation(id: number) {
    openIdRef.current = id;   // set before the async fetch so its guard is correct
    setSelectedId(id);
    setMessages([]);
    setError(null);
    setLoadingThread(true);
    loadThread(id, { markLocalRead: true }).finally(() => setLoadingThread(false));
  }

  async function submitReply() {
    const text = reply.trim();
    if (!text || !selectedId || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/admin/inbox"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reply", id: selectedId, text })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        setReply("");
        await loadThread(selectedId);
        await refreshList();
        notifyBadge();   // the reply cleared unread server-side
      } else {
        const r = j?.result as string | undefined;
        setError(
          r === "no_channel" ? "สาขานี้ยังไม่ได้ตั้งค่า LINE OA — ตอบกลับไม่ได้"
          : r === "push_failed" ? "ส่งข้อความไม่สำเร็จ ลองใหม่อีกครั้ง"
          : r === "no_conversation" ? "ไม่พบห้องแชทนี้"
          : r === "empty" ? "พิมพ์ข้อความก่อนส่งครับ"
          : "ส่งไม่สำเร็จ ลองใหม่อีกครั้ง"
        );
      }
    } catch {
      setError("เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง");
    } finally {
      setSending(false);
    }
  }

  // Poll: refresh the list, and the open thread, on a timer.
  useEffect(() => {
    if (!hasAccess) return;
    const tick = () => {
      refreshList();
      if (selectedId != null) loadThread(selectedId);
    };
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, [hasAccess, refreshList, loadThread, selectedId]);

  // Re-pull the list when the open/all filter flips.
  useEffect(() => { if (hasAccess) refreshList(); }, [showAll, hasAccess, refreshList]);

  // Keep the thread scrolled to the newest message.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages]);

  if (!hasAccess) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
        <OwlMascot size={72} mood="thinking" />
        <p className="text-sm text-slate-500 mt-3">
          บัญชีนี้ยังไม่ได้รับสิทธิ์ดูแลสาขา จึงยังไม่มีกล่องข้อความลูกค้าให้แสดง
        </p>
      </div>
    );
  }

  const totalUnread = conversations.reduce((n, c) => n + (c.unread ? 1 : 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <OwlMascot size={44} mood="smile" showCoffee={false} />
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-slate-800">กล่องข้อความลูกค้า</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            รวมแชทจาก LINE OA และ Facebook Messenger ไว้ที่เดียว — น้องฮูกช่วยเก็บไว้ให้ พี่กดตอบได้เลยครับ
            {" "}<Link href="/admin/inbox/facebook" className="text-brand hover:underline">เชื่อม Facebook</Link>
          </p>
        </div>
        {totalUnread > 0 && (
          <span className="mt-1 shrink-0 rounded-full bg-amber-500 text-white text-xs font-bold px-2.5 py-1">
            ยังไม่ได้อ่าน {totalUnread}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setShowAll(false)}
          className={`text-xs px-3 py-1 rounded-full border ${!showAll ? "bg-brand text-white border-brand" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
          กำลังคุย
        </button>
        <button type="button" onClick={() => setShowAll(true)}
          className={`text-xs px-3 py-1 rounded-full border ${showAll ? "bg-brand text-white border-brand" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
          ทั้งหมด
        </button>
      </div>

      {branchChips.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-slate-500">สาขา</span>
          <button type="button" onClick={() => pickBranch(null)}
            className={`text-xs px-3 py-1 rounded-full border ${activeBranch == null ? "bg-brand text-white border-brand" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
            ทุกสาขา
          </button>
          {branchChips.map((b) => (
            <button key={String(b.key)} type="button" onClick={() => pickBranch(b.key)}
              className={`text-xs px-3 py-1 rounded-full border ${activeBranch === b.key ? "bg-brand text-white border-brand" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
              {b.name}
              {b.unread > 0 && <span className={`ml-1.5 rounded-full px-1.5 text-[10px] font-bold ${activeBranch === b.key ? "bg-white/25" : "bg-amber-500 text-white"}`}>{b.unread}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="grid md:grid-cols-[320px_1fr] gap-4">
        {/* Conversation list — hidden on phones once a thread is open. */}
        <div className={`${selected ? "hidden md:block" : "block"} rounded-2xl border border-slate-200 bg-white overflow-hidden`}>
          {visibleConversations.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-400">ยังไม่มีข้อความจากลูกค้า</div>
          ) : (
            <ul className="divide-y divide-slate-100 max-h-[70vh] overflow-y-auto">
              {visibleConversations.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => openConversation(c.id)}
                    className={`w-full text-left px-3 py-2.5 hover:bg-slate-50 flex items-start gap-2 ${selectedId === c.id ? "bg-brand/5" : ""}`}>
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${c.unread ? "bg-amber-500" : "bg-transparent"}`} />
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 min-w-0">
                          {c.channel === "facebook" && (
                            <span className="shrink-0 text-[9px] font-bold px-1 py-0.5 rounded bg-blue-100 text-blue-700">FB</span>
                          )}
                          <span className={`truncate text-sm ${c.unread ? "font-bold text-slate-800" : "font-medium text-slate-700"}`}>
                            {convName(c)}
                          </span>
                        </span>
                        {c.branch_name && (
                          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-slate-400">{c.branch_name}</span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-slate-500 mt-0.5">
                        {c.last_message_preview ?? ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Thread + reply */}
        <div className={`${selected ? "block" : "hidden md:block"} rounded-2xl border border-slate-200 bg-white flex flex-col min-h-[420px] max-h-[75vh]`}>
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-400 p-6">
              เลือกห้องแชททางซ้ายเพื่อดูข้อความ
            </div>
          ) : (
            <>
              {/* Thread header */}
              <div className="border-b border-slate-200 px-4 py-3 flex items-center gap-2">
                <button type="button" onClick={() => setSelectedId(null)}
                  className="md:hidden text-slate-400 hover:text-slate-600 text-lg leading-none pr-1" aria-label="กลับ">←</button>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-slate-800 text-sm truncate">{convName(selected)}</div>
                  <div className="text-[11px] text-slate-400">
                    {selected.branch_name ? `${selected.branch_name} · ` : ""}{channelLabel(selected.channel)}
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div ref={bodyRef} className="flex-1 overflow-y-auto p-3 space-y-2 bg-slate-50/50">
                {loadingThread && messages.length === 0 ? (
                  <div className="text-center text-xs text-slate-400 py-6">กำลังโหลด…</div>
                ) : (
                  messages.map((m) => (
                    <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                        m.direction === "out"
                          ? "bg-brand text-white rounded-br-sm"
                          : "bg-white border border-slate-200 text-slate-800 rounded-bl-sm"
                      }`}>
                        {m.media_kind === "sticker" && m.media_ref ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`https://stickershop.line-scdn.net/stickershop/v1/sticker/${m.media_ref}/android/sticker.png`}
                            alt="สติกเกอร์" className="w-24 h-24 object-contain" loading="lazy" />
                        ) : m.media_kind === "image" ? (
                          <InboxImage id={m.id} fallback={m.body} />
                        ) : (
                          <div>{m.body}</div>
                        )}
                        <div className={`text-[10px] mt-1 ${m.direction === "out" ? "text-white/70" : "text-slate-400"}`}>
                          {m.direction === "out" && m.sent_by_name ? `${m.sent_by_name} · ` : ""}
                          {formatBkkDateTime(m.created_at)}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Reply box */}
              <div className="border-t border-slate-200 p-2.5 space-y-1.5">
                {error && <p className="text-xs text-rose-600 px-1">{error}</p>}
                <div className="flex items-end gap-2">
                  <textarea
                    className="input text-sm flex-1 resize-none"
                    rows={2}
                    placeholder="พิมพ์ข้อความตอบกลับ…"
                    value={reply}
                    disabled={sending}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitReply(); }
                    }}
                  />
                  <button type="button" onClick={submitReply} disabled={sending || !reply.trim()}
                    className="btn-primary !px-4 text-sm disabled:opacity-50 whitespace-nowrap">
                    {sending ? "…" : "ส่ง"}
                  </button>
                </div>
                <p className="text-[10px] text-slate-400 px-1">
                  {selected.channel === "facebook"
                    ? "ตอบผ่าน Facebook Messenger · ลูกค้าจะได้รับในแชทเพจ (ภายใน 24 ชม.หลังลูกค้าทัก)"
                    : "ตอบผ่าน LINE Push · ลูกค้าจะได้รับข้อความในแชท OA ทันที"} (กด Ctrl/⌘+Enter เพื่อส่ง)
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
