"use client";

import { useState, useEffect, useLayoutEffect, type RefObject } from "react";

// useLayoutEffect warns during SSR; client components still render on the
// server, so fall back to useEffect there.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

// Anchor a portal-rendered dropdown to an element using fixed positioning, so
// the list escapes any `overflow-hidden` / `overflow-auto` ancestor (the cards
// in ACCOUNTA clip an in-flow absolute dropdown). Recomputes on scroll/resize
// while open, and flips above the anchor when there isn't room below.

export type AnchorRect = {
  left: number;
  width: number;
  /** cap so a wide list never spills past the right viewport edge */
  maxWidth: number;
  /** distance from viewport top to the anchor's bottom edge (for top:) */
  below: number;
  /** distance from viewport bottom to the anchor's top edge (for bottom:) */
  above: number;
  openUp: boolean;
};

const SPACE = 4;       // gap between the anchor and the list
const NEED = 240;      // px of room we want below before flipping up

export function useAnchoredRect(
  open: boolean,
  ref: RefObject<HTMLElement>
): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);

  useIsoLayoutEffect(() => {
    if (!open || !ref.current) { setRect(null); return; }
    const el = ref.current;
    const update = () => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const roomBelow = vh - r.bottom;
      const openUp = roomBelow < NEED && r.top > roomBelow;
      setRect({
        left: r.left,
        width: r.width,
        maxWidth: Math.max(r.width, vw - r.left - SPACE * 2),
        below: r.bottom + SPACE,
        above: vh - r.top + SPACE,
        openUp
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, ref]);

  return rect;
}

/** Fixed-position style for the portal list, given the anchor rect. */
export function anchorStyle(rect: AnchorRect): React.CSSProperties {
  const base = { position: "fixed" as const, left: rect.left, minWidth: rect.width, maxWidth: rect.maxWidth };
  return rect.openUp ? { ...base, bottom: rect.above } : { ...base, top: rect.below };
}
