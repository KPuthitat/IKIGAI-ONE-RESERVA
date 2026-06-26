"use client";

// Per-table row layout: each table is a self-contained relative grid
// row that holds its own empty time-slot cells AND its own absolutely-
// positioned booking overlays. This keeps the grid math local to each
// row (so a booking on table A1 can't accidentally render across table
// A2's row) and avoids global grid-row gymnastics.
//
//   Row layout (per table):
//     ┌──────────┬───────┬───────┬───────┬───────┐
//     │  T1 (4)  │       │       │       │       │   ← empty cells
//     │          │  ░░ฌ╴ Booking #R...  ░░     │   ← absolute overlay
//     └──────────┴───────┴───────┴───────┴───────┘
//
// Click empty cell → walk-in modal pre-filled with table id + cell time.
// Click booking overlay → open /r/<ref> in new tab.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Branch, Booking, TableRow, Zone } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import BookingForm from "@/app/reserva/[branch]/BookingForm";
import BookingActionsModal from "./BookingActionsModal";

const SLOT_MINUTES = 15;   // 15-min granularity matches the customer
                           // booking picker — a customer who picked
                           // 18:15 lands in a slot that exists on the
                           // grid (the previous 30-min grid would have
                           // them straddle two columns).
const LABEL_COL_PX = 110;

// Zoom presets for cell width × row height. Lets staff trade off
// glance-ability ('wide' shows more text per cell) vs at-a-glance scope
// ('compact' fits more hours on a small laptop screen). Stored in
// localStorage so the choice persists across reloads.
type Zoom = "compact" | "normal" | "wide";
const ZOOM_PRESETS: Record<Zoom, { slotPx: number; rowPx: number }> = {
  compact: { slotPx: 48, rowPx: 36 },
  normal:  { slotPx: 64, rowPx: 44 },
  wide:    { slotPx: 88, rowPx: 56 }
};
const ZOOM_STORAGE_KEY = "reserva.timetable.zoom";

type Props = {
  branch: Branch;
  zones: Zone[];
  tables: TableRow[];
  bookings: Booking[];
  date: string;
};

export default function TimetableClient({ branch, zones, tables, bookings, date }: Props) {
  const router = useRouter();
  const { t } = useLang();
  // Two-step flow when admin clicks an empty cell:
  //   Step 1 (cellPicker, mode=null) — chooser asking "วอล์คอิน / ผ่านโทรศัพท์ / ผ่าน LINE"
  //   Step 2 (cellPicker, mode!=null) — BookingForm prefilled with the cell's
  //     table+time and the picked channel. Saved cell entries always pre-fill
  //     the table + time so admin doesn't re-enter what the click already
  //     conveyed.
  const [cellPicker, setCellPicker] = useState<{
    tableId: number;
    time: string;
    mode: "walkin" | "phone" | "line" | null;
  } | null>(null);
  // Click-to-edit on a booking overlay opens this modal (status actions,
  // table reassignment, cancel-with-reason). null = closed.
  const [editing, setEditing] = useState<Booking | null>(null);

  // Drag-and-drop: while a card is mid-drag, draggingId holds its id so
  // empty cells can render a "drop target" affordance. moveMsg is a
  // transient error toast (4s auto-clear) shown after a failed drop.
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [moveMsg, setMoveMsg] = useState<string | null>(null);

  async function moveBooking(bookingId: number, tableId: number, slotMinutes: number): Promise<void> {
    const h = Math.floor(slotMinutes / 60);
    const m = slotMinutes % 60;
    const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    setMoveMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/bookings/${bookingId}/move`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table_id: tableId, booking_time: time })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        const key =
          j.error === "slot_conflict" ? "admin.reserva.timetable.moveErr.conflict" :
          j.error === "table_unavailable" ? "admin.reserva.timetable.moveErr.tableGone" :
          "admin.reserva.timetable.moveErr.generic";
        setMoveMsg(t(key));
        window.setTimeout(() => setMoveMsg(null), 4000);
        return;
      }
      router.refresh();
    } catch {
      setMoveMsg(t("admin.reserva.timetable.moveErr.generic"));
      window.setTimeout(() => setMoveMsg(null), 4000);
    }
  }

  // Zoom state — start with whatever the user picked last time, default
  // to 'normal'. Persisted in localStorage on each change.
  const [zoom, setZoom] = useState<Zoom>("normal");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(ZOOM_STORAGE_KEY);
    if (saved === "compact" || saved === "normal" || saved === "wide") {
      setZoom(saved);
    }
  }, []);
  function changeZoom(z: Zoom): void {
    setZoom(z);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ZOOM_STORAGE_KEY, z);
    }
  }
  const SLOT_PX = ZOOM_PRESETS[zoom].slotPx;
  const ROW_PX = ZOOM_PRESETS[zoom].rowPx;

  const [openMin, closeMin] = useMemo(() => {
    const parse = (s: string | null | undefined, fallback: number) => {
      if (!s || !/^\d{2}:\d{2}$/.test(s)) return fallback;
      const [h, m] = s.split(":").map(Number);
      return h * 60 + m;
    };
    const o = parse(branch.open_time, 11 * 60);
    const c = parse(branch.close_time, 22 * 60);
    return [Math.floor(o / SLOT_MINUTES) * SLOT_MINUTES, Math.ceil(c / SLOT_MINUTES) * SLOT_MINUTES];
  }, [branch.open_time, branch.close_time]);

  const slotCount = Math.max(1, (closeMin - openMin) / SLOT_MINUTES);
  const slots = useMemo(() => {
    const arr: Array<{ index: number; minutes: number; label: string }> = [];
    for (let i = 0; i < slotCount; i++) {
      const m = openMin + i * SLOT_MINUTES;
      const h = Math.floor(m / 60);
      const mm = m % 60;
      arr.push({
        index: i,
        minutes: m,
        label: `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`
      });
    }
    return arr;
  }, [slotCount, openMin]);

  // Slots that fall inside the branch's lunch/closed break for THIS date.
  // Mirrors the customer-page rule (lib reserva): the break applies only
  // on weekdays listed in lunch_break_weekdays and is skipped on any date
  // in no_lunch_break_dates. Break slots render grey + non-clickable.
  const breakSlots = useMemo(() => {
    const set = new Set<number>();
    const bs = branch.lunch_break_start;
    const be = branch.lunch_break_end;
    if (!bs || !be || !/^\d{2}:\d{2}$/.test(bs) || !/^\d{2}:\d{2}$/.test(be)) return set;
    let weekdays: number[] = [];
    let exceptions: string[] = [];
    try { weekdays = branch.lunch_break_weekdays ? JSON.parse(branch.lunch_break_weekdays) : []; } catch {}
    try { exceptions = branch.no_lunch_break_dates ? JSON.parse(branch.no_lunch_break_dates) : []; } catch {}
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (!weekdays.includes(dow) || exceptions.includes(date)) return set;
    const toMin = (s: string) => {
      const [h, m] = s.split(":").map(Number);
      return h * 60 + m;
    };
    const bStart = toMin(bs);
    const bEnd = toMin(be);
    for (const s of slots) {
      if (s.minutes >= bStart && s.minutes < bEnd) set.add(s.index);
    }
    return set;
  }, [branch.lunch_break_start, branch.lunch_break_end,
      branch.lunch_break_weekdays, branch.no_lunch_break_dates, date, slots]);

  const groups = useMemo(() => {
    const zoneIds = new Set(zones.map((z) => z.id));
    const grouped: Array<{ zone: Zone | null; tables: TableRow[] }> = [];
    for (const z of zones) {
      const inZone = tables.filter((tbl) => tbl.zone_id === z.id);
      if (inZone.length > 0) grouped.push({ zone: z, tables: inZone });
    }
    const orphans = tables.filter((tbl) => tbl.zone_id == null || !zoneIds.has(tbl.zone_id));
    if (orphans.length > 0) grouped.push({ zone: null, tables: orphans });
    return grouped;
  }, [zones, tables]);

  const bookingsByTable = useMemo(() => {
    const map = new Map<number, Booking[]>();
    for (const b of bookings) {
      if (b.table_id == null) continue;
      if (!map.has(b.table_id)) map.set(b.table_id, []);
      map.get(b.table_id)!.push(b);
    }
    return map;
  }, [bookings]);

  const unassigned = useMemo(() => bookings.filter((b) => b.table_id == null), [bookings]);

  function onEmptyCellClick(tableId: number, slotMinutes: number): void {
    const h = Math.floor(slotMinutes / 60);
    const m = slotMinutes % 60;
    const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    // Open the type chooser first; admin picks walkin / phone / line, then
    // the booking form for that mode opens with the cell pre-filled.
    setCellPicker({ tableId, time, mode: null });
  }

  /** Convert a booking's start time + duration into pixel offset / width
   *  inside its row. Returns null when the booking falls entirely outside
   *  the open window (we just don't render those — they'll show as
   *  "unassigned" or simply be ignored). */
  function bookingPlacement(b: Booking): { left: number; width: number } | null {
    const [bh, bm] = b.booking_time.split(":").map(Number);
    const startMin = bh * 60 + bm;
    if (startMin >= closeMin) return null;
    const endMin = Math.min(closeMin, startMin + (b.duration_minutes || 90));
    if (endMin <= openMin) return null;
    const slotsFromOpen = (Math.max(startMin, openMin) - openMin) / SLOT_MINUTES;
    const left = LABEL_COL_PX + slotsFromOpen * SLOT_PX;
    const widthSlots = (endMin - Math.max(startMin, openMin)) / SLOT_MINUTES;
    return { left, width: Math.max(SLOT_PX * 0.4, widthSlots * SLOT_PX) };
  }

  function bookingTone(b: Booking): string {
    if (b.status === "seated") return "bg-emerald-200 border-emerald-400 text-emerald-900";
    if (b.status === "no_show") return "bg-rose-200 border-rose-400 text-rose-900";
    if (b.status === "completed") return "bg-violet-200 border-violet-400 text-violet-900";
    if (b.booking_channel === "walkin") return "bg-amber-200 border-amber-400 text-amber-900";
    return "bg-sky-200 border-sky-400 text-sky-900";
  }

  const totalWidth = LABEL_COL_PX + slotCount * SLOT_PX;
  const gridCols = `${LABEL_COL_PX}px repeat(${slotCount}, ${SLOT_PX}px)`;

  return (
    <div className="space-y-2">
      {/* Zoom toggle — lets staff trade compact (more hours visible) for
          wide (more text per cell). Persists per-user via localStorage. */}
      <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-slate-500">
        <div className="flex items-center gap-1">
          <span className="mr-1">{t("admin.reserva.timetable.zoom")}:</span>
          {(["compact", "normal", "wide"] as const).map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => changeZoom(z)}
              className={`px-2.5 py-1 rounded-md transition ${
                zoom === z
                  ? "bg-brand text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {t(`admin.reserva.timetable.zoom.${z}`)}
            </button>
          ))}
        </div>
        <div className="italic text-slate-400">
          {t("admin.reserva.timetable.dragHint")}
        </div>
      </div>

      {moveMsg && (
        <div className="rounded-lg border border-rose-300 bg-rose-50 text-rose-700 text-sm px-3 py-2">
          ✗ {moveMsg}
        </div>
      )}

      <div className="card !p-0 overflow-x-auto">
      {unassigned.length > 0 && (
        <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-xs">
          <div className="font-semibold text-amber-800 mb-1">
            ⚠ {t("admin.reserva.timetable.unassignedTitle", { n: unassigned.length })}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {unassigned.map((b) => (
              <Link key={b.id} href={`/r/${b.ref_no ?? b.id}`} target="_blank"
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white border border-amber-300 text-amber-900 hover:bg-amber-100">
                <span className="font-medium">{b.booking_time}</span>
                <span>·</span>
                <span>{b.customer_name}</span>
                <span className="text-amber-700">({b.party_size})</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div style={{ minWidth: totalWidth }}>
        {/* Header row — sticky time labels */}
        <div className="grid bg-slate-50 border-b border-slate-200 sticky top-0 z-20"
          style={{ gridTemplateColumns: gridCols }}>
          <div className="border-r border-slate-200 px-2 py-1 text-xs text-slate-500 font-semibold sticky left-0 bg-slate-50 z-10">
            {t("admin.reserva.timetable.tableCol")}
          </div>
          {slots.map((s) => (
            <div key={s.index}
              className={`text-xs text-center py-1 flex items-center justify-center ${
                breakSlots.has(s.index)
                  ? "bg-slate-200 text-slate-400"
                  : "text-slate-500"
              }`}
              style={{ height: ROW_PX }}
              title={breakSlots.has(s.index) ? t("admin.reserva.timetable.breakSlot") : undefined}>
              {s.label}
            </div>
          ))}
        </div>

        {/* Zone groups */}
        {groups.map((g) => (
          <div key={g.zone?.id ?? "none"}>
            {/* Zone header row spans full width */}
            <div className="bg-slate-100 border-b border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 sticky left-0">
              {g.zone ? g.zone.name : t("admin.reserva.timetable.zoneNone")}
              {g.zone?.description && (
                <span className="ml-2 font-normal text-slate-500">{g.zone.description}</span>
              )}
            </div>
            {g.tables.map((tbl) => (
              <TableRowComponent
                key={tbl.id}
                table={tbl}
                slots={slots}
                gridCols={gridCols}
                bookings={bookingsByTable.get(tbl.id) ?? []}
                rowPx={ROW_PX}
                breakSlots={breakSlots}
                draggingId={draggingId}
                onDragStart={setDraggingId}
                onDragEnd={() => setDraggingId(null)}
                onDropBooking={moveBooking}
                onEmptyCellClick={onEmptyCellClick}
                onEdit={(b) => setEditing(b)}
                bookingPlacement={bookingPlacement}
                bookingTone={bookingTone}
              />
            ))}
          </div>
        ))}

        {tables.length === 0 && (
          <div className="p-6 text-center text-sm text-slate-500">
            {t("admin.reserva.timetable.empty")}
          </div>
        )}
      </div>

      {/* Step 1: type chooser (mode still null). Admin picks the channel. */}
      {cellPicker && cellPicker.mode === null && (
        <CellTypeChooserModal
          tableId={cellPicker.tableId}
          time={cellPicker.time}
          tableLabel={tables.find((tb) => tb.id === cellPicker.tableId)?.label ?? ""}
          onClose={() => setCellPicker(null)}
          onPick={(mode) =>
            setCellPicker((prev) => (prev ? { ...prev, mode } : null))
          }
        />
      )}
      {/* Step 2: BookingForm in the chosen mode, prefilled with cell info. */}
      {cellPicker && cellPicker.mode !== null && (
        <CellBookingModal
          branch={branch}
          tableId={cellPicker.tableId}
          time={cellPicker.time}
          date={date}
          mode={cellPicker.mode}
          onBack={() =>
            setCellPicker((prev) => (prev ? { ...prev, mode: null } : null))
          }
          onClose={() => setCellPicker(null)}
          onSaved={() => { setCellPicker(null); router.refresh(); }}
        />
      )}
      {editing && (
        <BookingActionsModal
          booking={editing}
          // Tables free at the editing booking's slot — used by the
          // reassign dropdown. Computed client-side from the bookings
          // already in scope; cheap because both lists are small.
          availableTableIds={tables
            .filter((tbl) => isOverlapFree(bookings, editing.id, tbl.id, editing))
            .map((tbl) => tbl.id)}
          tables={tables.map((tbl) => ({
            id: tbl.id, label: tbl.label, capacity: tbl.capacity
          }))}
          onClose={() => setEditing(null)}
        />
      )}
      </div>
    </div>
  );
}

// True if `tableId` has no other booking in the same date overlapping
// with `target`'s time window. Considers existing in-scope bookings only
// (single date in this view), excludes the target booking itself, and
// ignores cancelled/completed bookings since they don't hold the table.
function isOverlapFree(
  all: Booking[], excludeId: number, tableId: number, target: Booking
): boolean {
  const targetStart = timeToMin(target.booking_time);
  const targetEnd = targetStart + (target.duration_minutes || 90);
  for (const b of all) {
    if (b.id === excludeId) continue;
    if (b.table_id !== tableId) continue;
    if (b.status === "cancelled" || b.status === "completed") continue;
    const start = timeToMin(b.booking_time);
    const end = start + (b.duration_minutes || 90);
    // Inclusive (boundary-touching) overlap — back-to-back bookings on
    // the same table are blocked. Matches lib/time.ts overlaps().
    if (start <= targetEnd && end >= targetStart) return false;
  }
  return true;
}

function timeToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function TableRowComponent({
  table, slots, gridCols, bookings, rowPx, breakSlots,
  draggingId, onDragStart, onDragEnd, onDropBooking,
  onEmptyCellClick, onEdit, bookingPlacement, bookingTone
}: {
  table: TableRow;
  slots: Array<{ index: number; minutes: number; label: string }>;
  gridCols: string;
  bookings: Booking[];
  rowPx: number;
  breakSlots: Set<number>;
  draggingId: number | null;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onDropBooking: (bookingId: number, tableId: number, slotMinutes: number) => void;
  onEmptyCellClick: (tableId: number, slotMinutes: number) => void;
  onEdit: (b: Booking) => void;
  bookingPlacement: (b: Booking) => { left: number; width: number } | null;
  bookingTone: (b: Booking) => string;
}) {
  // When a card is mid-drag we add a faint dashed outline to every
  // non-break empty cell to telegraph "you can drop here".
  const isDragging = draggingId != null;
  return (
    <div className="relative grid border-b border-slate-100"
      style={{ gridTemplateColumns: gridCols }}>
      {/* Sticky table label */}
      <div
        className="sticky left-0 z-10 bg-white border-r border-slate-200 px-2 py-1 text-sm font-medium text-slate-700 flex items-center justify-between"
        style={{ height: rowPx }}
      >
        <span>{table.label}</span>
        <span className="text-xs text-slate-400">{table.capacity}</span>
      </div>

      {/* Empty time-slot cells. Break slots render as inert grey cells —
          no walk-in can be seated while the kitchen/restaurant is closed
          for the break. Non-break cells double as drop targets for
          drag-and-drop booking moves. */}
      {slots.map((s) =>
        breakSlots.has(s.index) ? (
          <div
            key={s.index}
            className="border-r border-slate-100 bg-slate-100"
            style={{ height: rowPx }}
            aria-hidden
          />
        ) : (
          <button
            key={s.index}
            type="button"
            onClick={() => onEmptyCellClick(table.id, s.minutes)}
            onDragOver={(e) => {
              if (draggingId == null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              if (draggingId == null) return;
              e.preventDefault();
              const id = Number(e.dataTransfer.getData("text/plain"));
              if (Number.isInteger(id) && id > 0) {
                onDropBooking(id, table.id, s.minutes);
              }
            }}
            className={`border-r border-slate-100 transition relative ${
              isDragging
                ? "hover:bg-emerald-100 hover:ring-2 hover:ring-emerald-400 hover:ring-inset"
                : "hover:bg-emerald-50"
            }`}
            style={{ height: rowPx }}
            title={`+ ${s.label} · ${table.label}`}
          >
            <span className="sr-only">+ {table.label} {s.label}</span>
          </button>
        )
      )}

      {/* Booking overlays — absolute-positioned over the empty cells.
          Click opens BookingActionsModal so admin can change status,
          reassign table, or cancel. Drag the card to another empty cell
          (same row or another table) to atomically change table+time
          via /api/admin/bookings/[id]/move. */}
      {bookings.map((b) => {
        const place = bookingPlacement(b);
        if (!place) return null;
        const isThisDragging = draggingId === b.id;
        return (
          <button
            type="button"
            key={b.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", String(b.id));
              e.dataTransfer.effectAllowed = "move";
              onDragStart(b.id);
            }}
            onDragEnd={() => onDragEnd()}
            onClick={() => onEdit(b)}
            className={`absolute rounded-lg border ${bookingTone(b)} px-1.5 py-0.5 text-xs leading-tight overflow-hidden text-left shadow-sm hover:brightness-95 active:scale-[0.98] transition z-[5] cursor-grab active:cursor-grabbing ${
              isThisDragging ? "opacity-50 ring-2 ring-brand" : ""
            }`}
            style={{
              left: place.left + 2,
              width: place.width - 4,
              top: 2,
              height: rowPx - 4
            }}
            title={`${b.customer_name} · ${b.party_size} ที่นั่ง · ${b.booking_time}`}
          >
            <div className="font-semibold truncate">{b.customer_name}</div>
            <div className="opacity-80 truncate">
              {b.party_size} · {b.booking_time}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Step 1: type chooser ──────────────────────────────────────────────
// Asks admin which channel the booking is coming through. Three big
// buttons with icons + a tiny hint about what each one means. The cell
// (table + time) is shown in the header so admin sees what they picked.
function CellTypeChooserModal({
  tableId, time, tableLabel, onClose, onPick
}: {
  tableId: number;
  time: string;
  tableLabel: string;
  onClose: () => void;
  onPick: (mode: "walkin" | "phone" | "line") => void;
}) {
  void tableId;
  const { t } = useLang();
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 my-8 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-800 text-lg">
              {t("admin.reserva.timetable.cellPicker.title")}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              {t("admin.reserva.timetable.cellPicker.subtitle", {
                table: tableLabel, time
              })}
            </p>
          </div>
          <button type="button" onClick={onClose}
            aria-label={t("common.close")}
            className="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2">×</button>
        </div>

        <div className="grid grid-cols-1 gap-2">
          <CellTypeButton
            tone="primary"
            title={t("admin.bookings.addWalkin")}
            desc={t("admin.reserva.timetable.cellPicker.walkinDesc")}
            onClick={() => onPick("walkin")}
          />
          <CellTypeButton
            tone="secondary"
            title={t("admin.bookings.addPhone")}
            desc={t("admin.reserva.timetable.cellPicker.phoneDesc")}
            onClick={() => onPick("phone")}
          />
          <CellTypeButton
            tone="secondary"
            title={t("admin.bookings.addLine")}
            desc={t("admin.reserva.timetable.cellPicker.lineDesc")}
            onClick={() => onPick("line")}
          />
        </div>
      </div>
    </div>
  );
}

function CellTypeButton({
  tone, title, desc, onClick
}: {
  tone: "primary" | "secondary";
  title: string;
  desc: string;
  onClick: () => void;
}) {
  const cls = tone === "primary"
    ? "border-brand bg-brand/5 hover:bg-brand/10 text-brand"
    : "border-slate-200 bg-white hover:bg-slate-50 text-slate-800";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-xl border-[1.5px] p-3.5 transition active:scale-[0.99] ${cls}`}
    >
      <div className="font-bold">+ {title}</div>
      <div className="text-xs opacity-80 mt-0.5">{desc}</div>
    </button>
  );
}

// ── Step 2: BookingForm in the chosen mode ────────────────────────────
// Mounted after the chooser picks walkin / phone / line. Same layout as
// the other +add modals on the bookings page; adds a small "back" link
// to return to the chooser without losing the cell context.
function CellBookingModal({
  branch, tableId, time, date, mode, onBack, onClose, onSaved
}: {
  branch: Branch;
  tableId: number;
  time: string;
  date: string;
  mode: "walkin" | "phone" | "line";
  onBack: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLang();
  const titleKey =
    mode === "walkin" ? "admin.bookings.modal.walkinTitle"
    : mode === "phone" ? "admin.bookings.modal.phoneTitle"
    : "admin.bookings.modal.lineTitle";
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-slate-100 rounded-2xl shadow-xl border border-slate-200 max-w-2xl w-full p-5 my-8 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <button
              type="button"
              onClick={onBack}
              className="text-xs text-slate-500 hover:text-brand mb-1"
            >
              ← {t("common.back")}
            </button>
            <h2 className="font-bold text-slate-800 text-lg">{t(titleKey)}</h2>
            <p className="text-xs text-slate-500 mt-1">
              {t("admin.reserva.timetable.walkinHint", { time })}
            </p>
          </div>
          <button type="button" onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2">×</button>
        </div>
        <BookingForm
          branch={branch}
          liffId={null}
          mode={mode}
          initialTableId={tableId}
          initialBookingTime={time}
          initialBookingDate={date}
          onSuccess={() => onSaved()}
        />
      </div>
    </div>
  );
}
