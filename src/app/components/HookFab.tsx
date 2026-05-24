"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import OwlMascot from "./OwlMascot";
import {
  FAQ_CATEGORIES,
  searchFaq,
  type FaqAudience,
  type FaqCategory,
  type FaqEntry
} from "@/lib/owl-faq";
import { useLang } from "@/lib/LangProvider";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";

// One row in the "งานค้าง" feed at the top of the panel — owl
// surfaces queues admin should action on. Mirrors the server's
// PendingItem shape in /api/owl/admin-pending.
type OwlPendingItem = {
  kind:
    | "pending_review_bookings"
    | "confirmed_no_table"
    | "shift_unlock_requests"
    | "leave_requests";
  count: number;
  href: string;
};
type OwlPendingResponse = {
  user_name: string;
  user_prefix: string | null;
  branch_name: string | null;
  total: number;
  items: OwlPendingItem[];
};

// Persisted FAB position — {right, bottom} in CSS pixels measured from
// the viewport's bottom-right corner so the owl stays put when the
// window is resized in the same orientation. Defaults to the original
// bottom-right anchor on first load; users who never drag never see a
// change. Falls back silently if localStorage is unavailable (private
// mode, SSR, etc.).
const STORAGE_KEY = "ikigai.owl.fab.pos";
const DEFAULT_POS = { right: 16, bottom: 16 };
const FAB_SIZE = 72; // approximate hit-box; used for viewport clamping
const DRAG_THRESHOLD = 6; // px before tap → drag

function loadPosition(): { right: number; bottom: number } {
  if (typeof window === "undefined") return DEFAULT_POS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_POS;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.right === "number" && typeof parsed?.bottom === "number") {
      return parsed;
    }
  } catch { /* fall through */ }
  return DEFAULT_POS;
}

function savePosition(p: { right: number; bottom: number }): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch { /* ignore — non-essential */ }
}

// HookFab — น้องฮูก floating helper.
//
// Pinned bottom-right of the viewport. Click it → expands a chat
// panel that shows:
//   • A greeting from น้องฮูก
//   • Quick category chips
//   • A search box that filters the FAQ list live
//   • Up to 8 matching FAQ entries (collapsed by default; tap to expand)
//   • A "เปิดห้องน้องฮูกแบบเต็ม" link to /help for the full experience
//
// Audience-aware: the admin layout passes audience="admin", staff
// layout passes "staff". The chat panel hides FAQ entries that
// don't apply to that role (e.g. staff doesn't see admin-only
// roster-publish answers).

export default function HookFab({
  audience = "any"
}: {
  audience?: FaqAudience;
}) {
  const { lang } = useLang();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<FaqCategory | "">("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // FAB position state — restored from localStorage on first mount.
  // SSR-safe: starts at DEFAULT_POS so the server-rendered HTML and
  // the first client render match, then we sync from localStorage in
  // a useEffect (no hydration mismatch warning).
  const [pos, setPos] = useState(DEFAULT_POS);
  useEffect(() => { setPos(loadPosition()); }, []);

  // "งานค้าง" — admin-only digest of pending queues (new bookings,
  // tables waiting to be assigned, etc.). Fetched on mount + every 60s
  // while the page is open so the badge dot stays current without
  // requiring the user to refresh. Skipped for non-admin audiences
  // (staff/customer get the FAQ-only Owl).
  const [pending, setPending] = useState<OwlPendingResponse | null>(null);
  useEffect(() => {
    if (audience !== "admin") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(apiUrl("/api/owl/admin-pending"), {
          cache: "no-store"
        });
        if (!res.ok) return;
        const data = await res.json() as OwlPendingResponse;
        if (!cancelled) setPending(data);
      } catch { /* offline / 401 — ignore, owl stays in FAQ-only mode */ }
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [audience]);

  // Drag bookkeeping — captured on pointerdown, mutated on pointermove.
  // Using a ref instead of state so the move handler doesn't re-render
  // on every pixel. `moved` flips to true once movement exceeds the
  // tap threshold; that flag is what distinguishes "drag" (save +
  // suppress open toggle) from "tap" (open the panel).
  const dragRef = useRef<{
    startX: number; startY: number;
    startRight: number; startBottom: number;
    moved: boolean;
  } | null>(null);

  function onFabPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    // Capture so pointermove fires even if the finger drifts outside
    // the small owl hitbox.
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startRight: pos.right,
      startBottom: pos.bottom,
      moved: false
    };
  }

  function onFabPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    d.moved = true;
    // Moving in screen-space; we anchor from bottom-right so positive
    // x-screen movement reduces `right` and positive y-screen movement
    // reduces `bottom`.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nextRight = Math.min(vw - FAB_SIZE, Math.max(0, d.startRight - dx));
    const nextBottom = Math.min(vh - FAB_SIZE, Math.max(0, d.startBottom - dy));
    setPos({ right: nextRight, bottom: nextBottom });
  }

  function onFabPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d) return;
    if (d.moved) {
      // True drag — persist the new resting position and DON'T treat
      // the gesture as a tap.
      savePosition(pos);
    } else {
      // Tap (no movement) — toggle the panel as before.
      setOpen((o) => !o);
    }
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Panel anchor: hugs the FAB on the same right edge, sits just above
  // it. If the FAB has been dragged near the top of the screen, the
  // 560-tall panel would overflow upward → we clamp to a minimum top
  // gap so the panel stays fully visible.
  const panelBottom = Math.min(
    pos.bottom + FAB_SIZE + 8,
    // Leave at least 24px above the panel; panel is up to 560px tall.
    (typeof window === "undefined" ? 0 : window.innerHeight) - 560 - 24
  );
  const safePanelBottom = Math.max(panelBottom, pos.bottom + FAB_SIZE + 8);

  // Close the panel on Escape — feels native for a modal/popover.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const results = useMemo<FaqEntry[]>(() => {
    return searchFaq(q, {
      category: cat || undefined,
      audience,
      lang: lang === "en" ? "en" : "th"
    }).slice(0, 8);
  }, [q, cat, audience, lang]);

  // i18n strings inline — only ~10 strings, simpler than threading
  // through the global i18n dict for a non-critical surface.
  const T = lang === "en"
    ? {
        title: "Hi! I'm Hook",
        sub: "Pick a category or type a question",
        searchPh: "Type your question…",
        chipAll: "All",
        nope: "Hmm, I don't know that one yet. Open the help center?",
        openHelp: "Open the help center",
        seeAll: "See all FAQs",
        pendingTitle: "A few things to look at",
        pendingIntro: (name: string) =>
          `Hi ${name}, I noticed these are waiting for you:`,
        pendingItem: {
          pending_review_bookings: (n: number) =>
            `${n} new booking${n === 1 ? "" : "s"} need confirmation`,
          confirmed_no_table: (n: number) =>
            `${n} confirmed booking${n === 1 ? "" : "s"} with no table assigned`,
          shift_unlock_requests: (n: number) =>
            `${n} edit request${n === 1 ? "" : "s"} on locked shift reports`,
          leave_requests: (n: number) =>
            `${n} leave request${n === 1 ? "" : "s"} pending approval`
        }
      }
    : {
        title: "สวัสดีครับ ผมน้องฮูก",
        sub: "เลือกหมวด หรือพิมพ์คำถาม",
        searchPh: "พิมพ์คำถามที่ต้องการ…",
        chipAll: "ทั้งหมด",
        nope: "ยังไม่รู้คำตอบครับ ลองเปิดห้องน้องฮูกแบบเต็มดูครับ",
        openHelp: "เปิดห้องน้องฮูกแบบเต็ม",
        seeAll: "ดูคำถามทั้งหมด",
        pendingTitle: "มีงานค้างฝากดูครับ",
        pendingIntro: (name: string) =>
          `สวัสดีครับพี่ ${name} น้องฮูกฝากพี่ช่วยจัดการต่อด้วยนะครับ`,
        pendingItem: {
          pending_review_bookings: (n: number) =>
            `จองใหม่รอยืนยัน ${n} รายการ`,
          confirmed_no_table: (n: number) =>
            `รายการที่ confirm แล้วแต่ยังไม่ได้กำหนดโต๊ะ ${n} รายการ`,
          shift_unlock_requests: (n: number) =>
            `คำขอแก้รายงานกะที่ล็อกแล้ว ${n} รายการ`,
          leave_requests: (n: number) =>
            `คำขอลาที่รออนุมัติ ${n} รายการ`
        }
      };

  return (
    <>
      {/* FAB — bare owl, no circle wrapper. Drag to reposition (touch
          or mouse). Tap (no drag movement) toggles the panel. The
          position is persisted to localStorage so each device
          remembers where the user parked the owl. */}
      <button
        type="button"
        onPointerDown={onFabPointerDown}
        onPointerMove={onFabPointerMove}
        onPointerUp={onFabPointerUp}
        onPointerCancel={onFabPointerUp}
        aria-label={T.title}
        style={{ right: pos.right, bottom: pos.bottom, touchAction: "none" }}
        className={`fixed z-40 p-1 transition-transform select-none
          ${open
            ? "scale-95 opacity-80"
            : "hover:scale-110 active:scale-95"}
        `}
      >
        <OwlMascot size={64} mood={open ? "smile" : "sleepy"} />
        {/* Badge — when admin has pending items, show the count
            instead of "?". The count badge uses amber for urgency
            so it stands out against the brand-red "?" baseline. */}
        {!open && pending && pending.total > 0 ? (
          <span className="absolute top-0 right-0 bg-amber-500 text-white text-[10px]
              font-bold rounded-full min-w-[20px] h-5 px-1 flex items-center justify-center
              shadow-md ring-2 ring-white">
            {pending.total > 99 ? "99+" : pending.total}
          </span>
        ) : !open ? (
          <span className="absolute top-0 right-0 bg-brand text-white text-[10px]
              font-bold rounded-full w-5 h-5 flex items-center justify-center
              shadow-md">
            ?
          </span>
        ) : null}
      </button>

      {/* Panel — anchored to the current FAB position so it follows the
          owl when the user drags it to a new corner. Clamped near the
          top of the viewport so the 560-tall panel never overflows. */}
      {open && (
        <div
          style={{ right: pos.right, bottom: safePanelBottom }}
          className="fixed z-50
            w-[min(380px,calc(100vw-2rem))] max-h-[min(560px,calc(100vh-7rem))]
            bg-white rounded-2xl shadow-2xl border border-slate-200
            flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="bg-amber-50 border-b border-amber-200 px-4 py-3 flex items-start gap-3">
            <OwlMascot size={52} mood="wink" showCoffee={false} />
            <div className="flex-1 min-w-0">
              <div className="font-bold text-slate-800 text-sm">{T.title}</div>
              <div className="text-xs text-slate-500">{T.sub}</div>
            </div>
            <button type="button" onClick={() => setOpen(false)}
              aria-label="ปิด"
              className="text-slate-400 hover:text-slate-600 text-xl leading-none">
              ×
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {/* Pending queue — admin only. The owl plays the role of
                an attentive assistant, addressing the admin by name
                ("สวัสดีครับพี่ X น้องฮูกฝากพี่ช่วยจัดการต่อด้วยนะครับ")
                and listing the queues that need attention with deep
                links straight into the relevant admin page. */}
            {pending && pending.total > 0 && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 space-y-2">
                <div className="font-bold text-amber-900 text-sm">
                  {T.pendingTitle}
                </div>
                <div className="text-xs text-amber-800/90 leading-relaxed">
                  {T.pendingIntro(nameWithPrefix(pending.user_prefix, pending.user_name))}
                </div>
                <ul className="space-y-1 mt-1">
                  {pending.items.map((it) => (
                    <li key={it.kind}>
                      <Link
                        href={it.href}
                        onClick={() => setOpen(false)}
                        className="flex items-center justify-between gap-2 text-xs px-2 py-1.5 rounded-lg bg-white border border-amber-200 hover:border-amber-400 hover:bg-amber-50/50"
                      >
                        <span className="text-slate-700">
                          {T.pendingItem[it.kind]?.(it.count) ?? `${it.count}`}
                        </span>
                        <span className="text-brand font-bold">→</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Search */}
            <input
              type="text"
              className="input text-sm"
              placeholder={T.searchPh}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />

            {/* Category chips */}
            <div className="flex flex-wrap gap-1.5">
              <button type="button"
                onClick={() => setCat("")}
                className={`text-[11px] px-2 py-0.5 rounded-full border ${
                  cat === ""
                    ? "bg-brand text-white border-brand"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}>
                {T.chipAll}
              </button>
              {FAQ_CATEGORIES.map((c) => (
                <button key={c.id} type="button"
                  onClick={() => setCat(cat === c.id ? "" : c.id)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border ${
                    cat === c.id
                      ? "bg-brand text-white border-brand"
                      : "border-slate-300 text-slate-600 hover:bg-slate-50"
                  }`}>
                  {lang === "en" ? c.label_en : c.label_th}
                </button>
              ))}
            </div>

            {/* Results */}
            {results.length === 0 ? (
              <div className="text-center py-6">
                <OwlMascot size={64} mood="thinking" />
                <p className="text-xs text-slate-500 mt-2">{T.nope}</p>
                <Link href="/help" onClick={() => setOpen(false)}
                  className="inline-block mt-3 text-sm text-brand font-bold underline">
                  {T.openHelp}
                </Link>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {results.map((entry) => {
                  const expanded = expandedId === entry.id;
                  const cat = FAQ_CATEGORIES.find((c) => c.id === entry.category);
                  return (
                    <li key={entry.id} className="border border-slate-200 rounded-lg">
                      <button type="button"
                        onClick={() => setExpandedId(expanded ? null : entry.id)}
                        className="w-full text-left p-2.5 flex items-start gap-2 hover:bg-slate-50">
                        <span className="text-sm font-bold text-slate-800 flex-1">
                          {lang === "en" ? entry.question_en : entry.question_th}
                        </span>
                        <span className="text-slate-400 flex-shrink-0">
                          {expanded ? "−" : "+"}
                        </span>
                      </button>
                      {expanded && (
                        <div className="px-3 pb-3 border-t border-slate-100 pt-2">
                          <div className="text-xs text-slate-700 whitespace-pre-wrap leading-relaxed">
                            {lang === "en" ? entry.answer_en : entry.answer_th}
                          </div>
                          {entry.link && (
                            <Link href={entry.link.href}
                              onClick={() => setOpen(false)}
                              className="inline-block mt-2 text-xs text-brand font-bold underline">
                              → {lang === "en" ? entry.link.label_en : entry.link.label_th}
                            </Link>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-slate-200 p-2 bg-slate-50/50 text-center">
            <Link href="/help" onClick={() => setOpen(false)}
              className="text-xs text-brand font-bold hover:underline">
              {T.seeAll} →
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
