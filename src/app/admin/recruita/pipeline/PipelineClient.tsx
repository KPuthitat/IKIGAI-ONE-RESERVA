"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiUrl } from "@/lib/url";
import PinPromptModal from "@/app/components/PinPromptModal";
import type { ApplicationStage, PendingStageTag } from "@/lib/recruita";
import type { PipelineCard } from "./page";

type StageMeta = Record<ApplicationStage, { label: string; chip: string }>;
type PositionOpt = {
  id: number; title: string; code: string | null; application_count: number;
};

const STAGE_ORDER: ApplicationStage[] = [
  "applied", "screening", "interview", "health_check", "offered",
  "accepted", "hired", "rejected", "withdrawn"
];

// Column accent — used for the column header strip + drop highlight.
// Mirrors the chip palette so the card chip and column chrome match.
const STAGE_ACCENT: Record<ApplicationStage, { bar: string; ring: string }> = {
  applied:   { bar: "bg-slate-300",   ring: "ring-slate-400" },
  screening: { bar: "bg-sky-300",     ring: "ring-sky-400" },
  interview: { bar: "bg-amber-300",   ring: "ring-amber-400" },
  health_check: { bar: "bg-teal-300", ring: "ring-teal-400" },
  offered:   { bar: "bg-violet-300",  ring: "ring-violet-400" },
  accepted:  { bar: "bg-emerald-300", ring: "ring-emerald-400" },
  hired:     { bar: "bg-emerald-500", ring: "ring-emerald-600" },
  rejected:  { bar: "bg-rose-300",    ring: "ring-rose-400" },
  withdrawn: { bar: "bg-slate-400",   ring: "ring-slate-500" }
};

function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export default function PipelineClient({
  cards, positions, stageMeta, viewerHasPin, viewerUserId
}: {
  cards: PipelineCard[];
  positions: PositionOpt[];
  stageMeta: StageMeta;
  /** Whether the logged-in admin has a PIN. Request + approve are
   *  gated on this (same PIN the time-clock uses). */
  viewerHasPin: boolean;
  /** Logged-in admin id — enforces "approver ≠ requester" client-side
   *  (server enforces it too). */
  viewerUserId: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [positionFilter, setPositionFilter] = useState("");
  const [dragId, setDragId] = useState<number | null>(null);
  const [hoverStage, setHoverStage] = useState<ApplicationStage | null>(null);

  // Dual-admin flow modals (owner 2026-06-09: every stage move on the
  // board now needs a second admin to approve — same as the detail
  // page). Dropping / picking a stage opens the request modal; the
  // card does NOT move until a different admin approves.
  const [requestModal, setRequestModal] = useState<{ card: PipelineCard; to: ApplicationStage } | null>(null);
  const [approveCard, setApproveCard] = useState<PipelineCard | null>(null);
  const [cancelCard, setCancelCard] = useState<PipelineCard | null>(null);

  // Stage column never changes locally — we read straight from the
  // server-provided cards prop and router.refresh() after each action,
  // so the board always reflects the real (post-approval) stage.
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return cards.filter((c) => {
      if (positionFilter && String(c.position_id) !== positionFilter) return false;
      if (!term) return true;
      const hay = [
        c.first_name_th, c.last_name_th, c.nickname_th,
        c.mobile_phone, c.position_title, c.position_code
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(term);
    });
  }, [cards, q, positionFilter]);

  const byStage = useMemo(() => {
    const m = new Map<ApplicationStage, PipelineCard[]>();
    for (const s of STAGE_ORDER) m.set(s, []);
    for (const c of filtered) m.get(c.stage)?.push(c);
    return m;
  }, [filtered]);

  const pendingCount = useMemo(
    () => cards.filter((c) => c.pending).length, [cards]);

  // Open the request modal for (card → to). Guards keep us from
  // proposing a no-op, stacking onto an already-pending request, or
  // acting without a PIN.
  function proposeMove(card: PipelineCard, to: ApplicationStage) {
    setErr(null);
    if (card.stage === to) return;
    if (card.pending) {
      setErr("ใบสมัครนี้มีคำขอเปลี่ยนสถานะรออนุมัติอยู่แล้ว — อนุมัติหรือยกเลิกคำขอเดิมก่อน");
      return;
    }
    if (!viewerHasPin) {
      setErr("ต้องตั้ง PIN ก่อนเปลี่ยนสถานะ — ตั้งได้ที่หน้าลงเวลา (Time Clock)");
      return;
    }
    setRequestModal({ card, to });
  }

  function onDragStart(e: React.DragEvent, id: number) {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(id));
  }
  function onDragEnd() {
    setDragId(null);
    setHoverStage(null);
  }
  function onDragOver(e: React.DragEvent, stage: ApplicationStage) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (hoverStage !== stage) setHoverStage(stage);
  }
  function onDrop(e: React.DragEvent, stage: ApplicationStage) {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData("text/plain")) || dragId;
    setDragId(null); setHoverStage(null);
    if (!id) return;
    const card = cards.find((c) => c.id === id);
    if (card) proposeMove(card, stage);
  }

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="card flex flex-wrap items-center gap-2">
        <input className="input flex-1 min-w-[200px]"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="🔍 ค้นชื่อ / เบอร์ / ตำแหน่ง" />
        <select className="input !w-auto"
          value={positionFilter}
          onChange={(e) => setPositionFilter(e.target.value)}>
          <option value="">— ทุกตำแหน่ง —</option>
          {positions.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.code ? `[${p.code}] ` : ""}{p.title} ({p.application_count})
            </option>
          ))}
        </select>
        <div className="text-xs text-slate-400">
          แสดง {filtered.length} / {cards.length} ใบสมัคร
        </div>
      </div>

      {/* Pending-approval summary — makes it obvious at a glance that
          some cards are waiting on a second admin. */}
      {pendingCount > 0 && (
        <div className="card bg-amber-50 border border-amber-200 text-amber-800 text-sm">
          มี {pendingCount} ใบสมัครที่ <b>รออนุมัติเปลี่ยนสถานะ</b> — แอดมินอีกคนต้องกดอนุมัติด้วย PIN
        </div>
      )}

      {err && (
        <div className="card bg-rose-50 border border-rose-200 text-rose-700 text-sm">
          ✗ {err}
        </div>
      )}

      {/* Kanban board — horizontal scroll on narrow viewports */}
      <div className="overflow-x-auto">
        <div className="flex gap-3 min-w-max pb-2">
          {STAGE_ORDER.map((stage) => {
            const meta = stageMeta[stage];
            const accent = STAGE_ACCENT[stage];
            const list = byStage.get(stage) ?? [];
            const isHover = hoverStage === stage && dragId != null;
            return (
              <div key={stage}
                onDragOver={(e) => onDragOver(e, stage)}
                onDrop={(e) => onDrop(e, stage)}
                className={`w-[280px] flex-shrink-0 rounded-xl bg-slate-50 border border-slate-200 ${
                  isHover ? `ring-2 ${accent.ring} ring-offset-2` : ""
                }`}>
                {/* Column header */}
                <div className={`h-1.5 rounded-t-xl ${accent.bar}`} />
                <div className="px-3 py-2 border-b border-slate-200 sticky top-0 bg-slate-50 z-10 rounded-t-xl">
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${meta.chip}`}>
                      {meta.label}
                    </span>
                    <span className="text-xs text-slate-500 tabular-nums">
                      {list.length}
                    </span>
                  </div>
                </div>

                {/* Cards */}
                <div className="p-2 space-y-2 min-h-[180px]">
                  {list.length === 0 && (
                    <div className="text-[11px] text-slate-300 text-center py-6 border-2 border-dashed border-slate-200 rounded-lg">
                      ลากการ์ดมาที่นี่
                    </div>
                  )}
                  {list.map((c) => (
                    <Card key={c.id} card={c}
                      stageMeta={stageMeta}
                      dragging={dragId === c.id}
                      busy={busy}
                      viewerHasPin={viewerHasPin}
                      viewerUserId={viewerUserId}
                      onDragStart={(e) => onDragStart(e, c.id)}
                      onDragEnd={onDragEnd}
                      onPropose={(to) => proposeMove(c, to)}
                      onApprove={() => { setErr(null); setApproveCard(c); }}
                      onCancel={() => { setErr(null); setCancelCard(c); }} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-[11px] text-slate-400 text-center">
        💡 ลาก/เลือก stage = ส่งคำขอเปลี่ยนสถานะ · ต้องมีแอดมินคนที่ 2 อนุมัติด้วย PIN
      </p>

      {/* ── Request / change modal (Admin A) ────────────────────────
          Only ใบสมัครใหม่ → คัดกรอง needs a 2nd admin (owner 2026-06-11);
          every other move is applied immediately with this admin's PIN. */}
      {requestModal && (() => {
        const isDual = requestModal.card.stage === "applied" && requestModal.to === "screening";
        return (
        <PinPromptModal
          title={isDual ? "ขออนุมัติเปลี่ยนสถานะ (2 แอดมิน)" : "ยืนยันเปลี่ยนสถานะ"}
          description={
            <>
              <b>{cardName(requestModal.card)}</b>
              <br />จาก <b>{stageMeta[requestModal.card.stage].label}</b> ไป{" "}
              <b>{stageMeta[requestModal.to].label}</b>
              <br />{isDual
                ? "ใส่ PIN ของคุณเพื่อสร้างคำขอ (ต้องมีแอดมินคนที่ 2 อนุมัติ)"
                : "ใส่ PIN ของคุณเพื่อเปลี่ยนสถานะทันที"}
            </>
          }
          submitLabel={isDual ? "ส่งคำขอ" : "เปลี่ยนสถานะ"}
          onClose={() => setRequestModal(null)}
          onSubmit={async (pin) => {
            const res = await fetch(
              apiUrl(`/api/recruita/applications/${requestModal.card.id}/stage-request`),
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ to_stage: requestModal.to, pin })
              }
            );
            const j = await res.json().catch(() => ({}));
            if (!res.ok || !j.ok) {
              return { ok: false, message: j.message ?? j.error ?? "ส่งคำขอไม่สำเร็จ" };
            }
            setRequestModal(null);
            startTransition(() => router.refresh());
            return { ok: true };
          }} />
        );
      })()}

      {/* ── Approve modal (Admin B) ─────────────────────────────── */}
      {approveCard && approveCard.pending && (
        <PinPromptModal
          title="อนุมัติการเปลี่ยนสถานะ"
          description={
            <>
              <b>{cardName(approveCard)}</b>
              <br />อนุมัติเปลี่ยน <b>{stageMeta[approveCard.pending.from_stage].label}</b>
              {" "}→ <b>{stageMeta[approveCard.pending.to_stage].label}</b>
              <br />ใส่ PIN ของคุณเพื่อยืนยัน
            </>
          }
          submitLabel="อนุมัติ"
          onClose={() => setApproveCard(null)}
          onSubmit={async (pin) => {
            const res = await fetch(
              apiUrl(`/api/recruita/applications/${approveCard.id}/stage-request/${approveCard.pending!.id}`),
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pin })
              }
            );
            const j = await res.json().catch(() => ({}));
            if (!res.ok || !j.ok) {
              return { ok: false, message: j.message ?? j.error ?? "อนุมัติไม่สำเร็จ" };
            }
            setApproveCard(null);
            startTransition(() => router.refresh());
            return { ok: true };
          }} />
      )}

      {/* ── Cancel modal (requester or super_admin) ─────────────── */}
      {cancelCard && cancelCard.pending && (
        <CancelModal
          name={cardName(cancelCard)}
          busy={busy}
          onClose={() => setCancelCard(null)}
          onConfirm={async (reason) => {
            setBusy(true);
            try {
              const res = await fetch(
                apiUrl(`/api/recruita/applications/${cancelCard.id}/stage-request/${cancelCard.pending!.id}`),
                {
                  method: "DELETE",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ reason })
                }
              );
              const j = await res.json().catch(() => ({}));
              if (!res.ok || !j.ok) {
                return { ok: false as const, message: j.error ?? "ยกเลิกไม่สำเร็จ" };
              }
              setCancelCard(null);
              startTransition(() => router.refresh());
              return { ok: true as const };
            } finally { setBusy(false); }
          }} />
      )}
    </div>
  );
}

function cardName(card: PipelineCard): string {
  const name = [card.title_prefix, card.first_name_th, card.last_name_th]
    .filter(Boolean).join(" ") || "—";
  return card.nickname_th ? `${name} (${card.nickname_th})` : name;
}

// ── Single card ────────────────────────────────────────────────────
function Card({
  card, stageMeta, dragging, busy, viewerHasPin, viewerUserId,
  onDragStart, onDragEnd, onPropose, onApprove, onCancel
}: {
  card: PipelineCard;
  stageMeta: StageMeta;
  dragging: boolean;
  busy: boolean;
  viewerHasPin: boolean;
  viewerUserId: number;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onPropose: (to: ApplicationStage) => void;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const pending = card.pending;

  const name = [card.title_prefix, card.first_name_th, card.last_name_th]
    .filter(Boolean).join(" ") || "—";
  const nick = card.nickname_th ? ` (${card.nickname_th})` : "";
  const submitted = daysSince(card.submitted_at);
  const inStage = card.updated_at ? daysSince(card.updated_at) : submitted;

  return (
    <div
      // A card with a pending request is locked from dragging — the
      // existing request must be approved or cancelled first.
      draggable={!busy && !pending}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`bg-white rounded-lg border p-2 shadow-sm hover:shadow-md transition ${
        pending ? "border-amber-300 cursor-default" : "border-slate-200 cursor-grab active:cursor-grabbing"
      } ${dragging ? "opacity-50 ring-2 ring-brand" : ""}`}>
      <div className="text-[10px] text-slate-400 font-mono mb-1">#{card.id}</div>
      <Link href={`/admin/recruita/applications/${card.id}`}
        className="block text-sm font-bold text-slate-800 hover:text-brand truncate"
        onClick={(e) => e.stopPropagation()}>
        {name}{nick}
      </Link>
      <div className="text-[11px] text-slate-500 truncate mt-0.5">
        {card.position_code ? `[${card.position_code}] ` : ""}{card.position_title}
      </div>
      {card.branch_name && (
        <div className="text-[10px] text-slate-500 truncate font-semibold">{card.branch_name}</div>
      )}
      <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-2 flex-wrap">
        <span>ส่ง {submitted}d</span>
        {inStage !== submitted && <span>· stage {inStage}d</span>}
        {card.expected_salary != null && (
          <span className="text-emerald-700">฿{card.expected_salary.toLocaleString("th-TH")}</span>
        )}
        {/* LINE binding status (owner 2026-06-13) — amber = needs manual
            link before this candidate can receive any push. */}
        {card.line_linked ? (
          <span className="text-green-600 font-medium">● เชื่อมต่อ UserID แล้ว</span>
        ) : (
          <span className="text-amber-800 font-medium bg-amber-100 px-1.5 py-0.5 rounded">ยังไม่เชื่อมต่อ UserID</span>
        )}
      </div>

      {pending ? (
        <PendingBlock
          pending={pending}
          stageMeta={stageMeta}
          viewerHasPin={viewerHasPin}
          viewerUserId={viewerUserId}
          busy={busy}
          onApprove={onApprove}
          onCancel={onCancel} />
      ) : (
        /* Stage chip / picker — proposes a dual-admin stage change. */
        <div className="mt-1.5 pt-1.5 border-t border-slate-100">
          {picking ? (
            <div className="space-y-0.5">
              <div className="text-[10px] text-slate-500 mb-1">ขอเปลี่ยน stage เป็น:</div>
              {STAGE_ORDER.filter((s) => s !== card.stage).map((s) => {
                const m = stageMeta[s];
                return (
                  <button key={s} type="button"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPicking(false);
                      onPropose(s);
                    }}
                    className={`w-full text-[10px] px-1.5 py-1 rounded text-left ${m.chip} hover:ring-1 hover:ring-slate-300`}>
                    → {m.label}
                  </button>
                );
              })}
              <button type="button"
                onClick={(e) => { e.stopPropagation(); setPicking(false); }}
                className="w-full text-[10px] px-1.5 py-1 rounded text-slate-500 hover:bg-slate-50">
                ยกเลิก
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <button type="button" disabled={busy}
                onClick={(e) => { e.stopPropagation(); setPicking(true); }}
                className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${stageMeta[card.stage].chip} hover:ring-1 hover:ring-slate-300`}>
                {stageMeta[card.stage].label} ▾
              </button>
              {/* Shortcut to the full application / history — opens in a new
                  tab so the board (filters + scroll) isn't lost. */}
              <Link href={`/admin/recruita/applications/${card.id}`}
                target="_blank" rel="noopener"
                onClick={(e) => e.stopPropagation()}
                className="text-[10px] text-brand font-semibold hover:underline whitespace-nowrap">
                ดูใบสมัคร ↗
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Pending-approval block inside a card ───────────────────────────
function PendingBlock({
  pending, stageMeta, viewerHasPin, viewerUserId, busy, onApprove, onCancel
}: {
  pending: PendingStageTag;
  stageMeta: StageMeta;
  viewerHasPin: boolean;
  viewerUserId: number;
  busy: boolean;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const requester = [pending.requester_prefix, pending.requester_name]
    .filter(Boolean).join(" ") || "—";
  const isRequester = pending.requested_by === viewerUserId;

  return (
    <div className="mt-1.5 pt-1.5 border-t border-amber-100 space-y-1.5">
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-amber-100 text-amber-800">
          รออนุมัติเปลี่ยนสถานะ
        </span>
      </div>
      <div className="text-[10px] text-slate-500 flex items-center gap-1 flex-wrap">
        <span className={`px-1.5 py-0.5 rounded-full font-bold ${stageMeta[pending.from_stage].chip}`}>
          {stageMeta[pending.from_stage].label}
        </span>
        →
        <span className={`px-1.5 py-0.5 rounded-full font-bold ${stageMeta[pending.to_stage].chip}`}>
          {stageMeta[pending.to_stage].label}
        </span>
      </div>
      <div className="text-[10px] text-slate-400">โดย {requester}</div>
      <div className="flex items-center gap-1.5">
        {isRequester ? (
          <span className="flex-1 text-[10px] text-slate-500 bg-slate-50 rounded px-1.5 py-1 text-center">
            คุณเป็นผู้ขอ — รออีกคนอนุมัติ
          </span>
        ) : (
          <button type="button"
            onClick={(e) => { e.stopPropagation(); onApprove(); }}
            disabled={busy || !viewerHasPin}
            className="flex-1 text-[10px] font-bold py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50">
            ✓ อนุมัติ
          </button>
        )}
        <button type="button"
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
          disabled={busy}
          className="text-[10px] py-1 px-2 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
          ยกเลิก
        </button>
      </div>
      {!isRequester && !viewerHasPin && (
        <a href="/staff/persona" className="block text-[10px] text-rose-600 underline">
          ตั้ง PIN ก่อนอนุมัติ
        </a>
      )}
    </div>
  );
}

// ── Cancel-request modal (optional reason) ─────────────────────────
function CancelModal({
  name, busy, onClose, onConfirm
}: {
  name: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function go() {
    setWorking(true);
    setErr(null);
    try {
      const res = await onConfirm(reason.trim());
      if (!res.ok) setErr(res.message);
    } finally { setWorking(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="font-bold text-slate-800">ยกเลิกคำขอเปลี่ยนสถานะ</h3>
          <p className="text-xs text-slate-600 mt-1">
            ของ <b>{name}</b> — ทำได้เฉพาะผู้ขอหรือผู้ดูแลระบบสูงสุด
          </p>
        </div>
        <div>
          <label className="label">เหตุผล (ทางเลือก)</label>
          <input className="input text-sm" value={reason} maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder="เช่น เลือกผิด stage" />
        </div>
        {err && <p className="text-rose-600 text-xs font-medium">✗ {err}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={working || busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium disabled:opacity-50">
            กลับ
          </button>
          <button type="button" onClick={go} disabled={working || busy}
            className="flex-1 py-2.5 rounded-lg bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 disabled:opacity-50">
            {working ? "กำลังยกเลิก…" : "ยกเลิกคำขอ"}
          </button>
        </div>
      </div>
    </div>
  );
}
