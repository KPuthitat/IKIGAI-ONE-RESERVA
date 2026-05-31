"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiUrl } from "@/lib/url";
import type { ApplicationStage } from "@/lib/recruita";
import type { PipelineCard } from "./page";

type StageMeta = Record<ApplicationStage, { label: string; chip: string }>;
type PositionOpt = {
  id: number; title: string; code: string | null; application_count: number;
};

const STAGE_ORDER: ApplicationStage[] = [
  "applied", "screening", "interview", "offered",
  "accepted", "hired", "rejected", "withdrawn"
];

// Column accent — used for the column header strip + drop highlight.
// Mirrors the chip palette so the card chip and column chrome match.
const STAGE_ACCENT: Record<ApplicationStage, { bar: string; ring: string }> = {
  applied:   { bar: "bg-slate-300",   ring: "ring-slate-400" },
  screening: { bar: "bg-sky-300",     ring: "ring-sky-400" },
  interview: { bar: "bg-amber-300",   ring: "ring-amber-400" },
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
  cards: initialCards, positions, stageMeta
}: {
  cards: PipelineCard[];
  positions: PositionOpt[];
  stageMeta: StageMeta;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Optimistic local copy of the cards so a drag visually commits
  // instantly even before the server round-trip finishes.
  const [cards, setCards] = useState(initialCards);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [positionFilter, setPositionFilter] = useState("");
  const [dragId, setDragId] = useState<number | null>(null);
  const [hoverStage, setHoverStage] = useState<ApplicationStage | null>(null);

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

  async function moveCard(id: number, to: ApplicationStage) {
    setErr(null);
    const prev = cards.find((c) => c.id === id)?.stage;
    if (!prev || prev === to) return;
    // Optimistic update
    setCards((p) => p.map((c) => c.id === id ? { ...c, stage: to } : c));
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/recruita/applications/${id}/stage`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: to })
      });
      if (!res.ok) {
        // Roll back on failure
        setCards((p) => p.map((c) => c.id === id ? { ...c, stage: prev } : c));
        const j = await res.json().catch(() => ({}));
        setErr(j.error ?? "เปลี่ยน stage ไม่สำเร็จ");
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setCards((p) => p.map((c) => c.id === id ? { ...c, stage: prev } : c));
      setErr("เครือข่ายมีปัญหา ลองอีกครั้ง");
    } finally { setBusy(false); }
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
    if (id) void moveCard(id, stage);
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
                      onDragStart={(e) => onDragStart(e, c.id)}
                      onDragEnd={onDragEnd}
                      onMove={(to) => moveCard(c.id, to)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-[11px] text-slate-400 text-center">
        💡 บนเดสก์ท็อปลากการ์ดได้ · บนมือถือคลิก chip ในการ์ดเพื่อเปลี่ยน stage
      </p>
    </div>
  );
}

// ── Single card ────────────────────────────────────────────────────
function Card({
  card, stageMeta, dragging, busy, onDragStart, onDragEnd, onMove
}: {
  card: PipelineCard;
  stageMeta: StageMeta;
  dragging: boolean;
  busy: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onMove: (to: ApplicationStage) => void;
}) {
  const [picking, setPicking] = useState(false);

  const name = [card.first_name_th, card.last_name_th]
    .filter(Boolean).join(" ") || "—";
  const nick = card.nickname_th ? ` (${card.nickname_th})` : "";
  const submitted = daysSince(card.submitted_at);
  const inStage = card.updated_at ? daysSince(card.updated_at) : submitted;

  return (
    <div
      draggable={!busy}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`bg-white rounded-lg border border-slate-200 p-2 shadow-sm hover:shadow-md transition cursor-grab active:cursor-grabbing ${
        dragging ? "opacity-50 ring-2 ring-brand" : ""
      }`}>
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
        <div className="text-[10px] text-slate-400 truncate">📍 {card.branch_name}</div>
      )}
      <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-2 flex-wrap">
        <span>📅 ส่ง {submitted}d</span>
        {inStage !== submitted && <span>· stage {inStage}d</span>}
        {card.expected_salary != null && (
          <span className="text-emerald-700">฿{card.expected_salary.toLocaleString("th-TH")}</span>
        )}
      </div>

      {/* Stage chip / picker — for non-drag flow (mobile) */}
      <div className="mt-1.5 pt-1.5 border-t border-slate-100">
        {picking ? (
          <div className="space-y-0.5">
            <div className="text-[10px] text-slate-500 mb-1">เลือก stage:</div>
            {STAGE_ORDER.filter((s) => s !== card.stage).map((s) => {
              const m = stageMeta[s];
              return (
                <button key={s} type="button"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPicking(false);
                    onMove(s);
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
          <button type="button" disabled={busy}
            onClick={(e) => { e.stopPropagation(); setPicking(true); }}
            className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${stageMeta[card.stage].chip} hover:ring-1 hover:ring-slate-300`}>
            {stageMeta[card.stage].label} ▾
          </button>
        )}
      </div>
    </div>
  );
}
