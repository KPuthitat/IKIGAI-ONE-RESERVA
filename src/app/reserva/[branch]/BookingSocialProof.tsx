"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// Live social-proof + real-scarcity widget for the public booking page.
//
// Two psychology principles in play, both grounded in REAL numbers
// (never inflated — at our volume customers would catch fake counts
// across visits):
//
//   • Social proof — "X ครอบครัวเลือกเราในสัปดาห์นี้". Weekly window
//     instead of daily because 4 bookings/day flickers between 0/1/2;
//     the 7-day total stays warm and meaningful.
//
//   • Real scarcity — per-slot remaining-seat count for the date the
//     customer is currently looking at. When a slot is at/near
//     capacity it shows "⚠ เหลือ 2 ที่" or "✗ เต็มแล้ว". When the
//     slot is historically the most-booked we add a "🔥 รอบนิยม" cue
//     (last 30 days, top 30% of slots). No fake countdown timers.
//
// We hide the whole widget when weekly bookings == 0 — at a brand-new
// branch a "0 ครอบครัว" line would backfire harder than no widget at
// all. Once at least one real booking exists we start displaying.

type SocialProofData = {
  weekly: { bookings: number; guests: number };
  today: { bookings: number; guests: number };
  slots: Array<{ time: string; bookedSeats: number; popular: boolean }>;
  totalCapacity: number;
};

export default function BookingSocialProof({
  branchSlug,
  bookingDate
}: {
  branchSlug: string;
  /** YYYY-MM-DD — the date the customer is currently looking at on the
   *  form. Refetches when it changes so the slot scarcity reflects the
   *  date in question. */
  bookingDate: string;
}) {
  const { t } = useLang();
  const [data, setData] = useState<SocialProofData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!bookingDate || !/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) return;
    let cancelled = false;
    setLoading(true);
    fetch(apiUrl(`/api/bookings/social-proof?branch_slug=${encodeURIComponent(branchSlug)}&date=${bookingDate}`))
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (!cancelled && j && !j.error) setData(j); })
      .catch(() => { /* silent — widget just stays hidden */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [branchSlug, bookingDate]);

  // Brand-new branch (no completed bookings yet) — hide rather than
  // print embarrassing zeros.
  if (loading && !data) return null;
  if (!data) return null;
  if (data.weekly.bookings === 0) return null;

  // Show top 3 popular slots that still have availability on the
  // selected date. Falls back to top 3 popular slots regardless of
  // availability if none are currently free. Limit to 3 so the widget
  // stays glanceable.
  const popularSlots = data.slots
    .filter((s) => s.popular)
    .sort((a, b) => a.time.localeCompare(b.time));
  const fullSlots = data.slots
    .filter((s) => s.bookedSeats >= data.totalCapacity)
    .sort((a, b) => a.time.localeCompare(b.time));

  // Per-slot scarcity hint with a 3-tier visual:
  //   full     — bookedSeats >= totalCapacity. Red. "เต็มแล้ว"
  //   tight    — remaining / total <= 25%.       Amber. "เหลือ N ที่"
  //   open     — anything else.                  Slate. "ว่าง"
  function slotHint(slot: { time: string; bookedSeats: number }): {
    label: string; color: string;
  } {
    const remaining = data!.totalCapacity - slot.bookedSeats;
    if (remaining <= 0) {
      return { label: t("booking.proof.slotFull"), color: "text-rose-600" };
    }
    const ratio = remaining / Math.max(1, data!.totalCapacity);
    if (ratio <= 0.25) {
      return {
        label: t("booking.proof.slotTight", { n: remaining }),
        color: "text-amber-700"
      };
    }
    return { label: t("booking.proof.slotOpen"), color: "text-slate-500" };
  }

  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 px-4 py-3 space-y-2.5">
      {/* Weekly headline — the social-proof message itself. Bold,
          warm copy. Uses guest count when guests > 0 so the number
          feels larger ("84 ที่นั่ง" reads stronger than "28 จอง"
          for small absolute counts). */}
      <div className="flex items-start gap-2">
        <span aria-hidden className="text-lg leading-none mt-0.5">🌿</span>
        <div className="text-sm text-emerald-900 leading-snug">
          <div className="font-bold">
            {t("booking.proof.weeklyHeadline", {
              bookings: data.weekly.bookings,
              guests: data.weekly.guests
            })}
          </div>
          <div className="text-[11px] text-emerald-700/80 mt-0.5">
            {t("booking.proof.weeklySubtitle")}
          </div>
        </div>
      </div>

      {/* Per-slot scarcity — only render when there's something
          interesting to say (at least one popular or full slot today). */}
      {(popularSlots.length > 0 || fullSlots.length > 0) && (
        <div className="border-t border-emerald-200/60 pt-2 space-y-1">
          {popularSlots.length > 0 && (
            <div className="text-[11px] text-emerald-800/90 font-medium">
              🔥 {t("booking.proof.popularLabel")}
            </div>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {popularSlots.slice(0, 4).map((s) => {
              const hint = slotHint(s);
              return (
                <span key={s.time} className="inline-flex items-center gap-1">
                  <span className="font-semibold text-emerald-900">{s.time}</span>
                  <span className={hint.color}>· {hint.label}</span>
                </span>
              );
            })}
            {popularSlots.length === 0 && fullSlots.length > 0 && (
              <span className="text-rose-600">
                {t("booking.proof.fullSlots")}:{" "}
                {fullSlots.slice(0, 4).map((s) => s.time).join(", ")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
