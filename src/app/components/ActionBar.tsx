"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState
} from "react";
import { createPortal } from "react-dom";

// Sticky bottom action bar (owner 2026-08, PGH-style). A page drops an
// <ActionBar> anywhere in its tree and its content teleports into a fixed
// bar pinned to the bottom of the viewport — left = context (record name,
// running totals), right = the page's action buttons (บันทึก / พิมพ์ /
// ส่งออก …). Opt-in: pages that don't render an <ActionBar> get no bar, so
// dashboards and lists are unaffected.
//
// Mechanics:
//  - The provider (mounted once per layout) portals the bar shell to
//    document.body, so no `overflow-x-clip`/transform ancestor can clip it.
//  - It counts mounted <ActionBar>s; the shell is hidden (and the content
//    wrapper drops its bottom padding) when the count is 0.
//  - <ActionBar> portals its own row into the shell. One page = one bar is
//    the norm; multiple just stack.

type Ctx = { target: HTMLElement | null; register: () => void; unregister: () => void };
const ActionBarCtx = createContext<Ctx | null>(null);

export function ActionBarProvider({
  children,
  maxWidth = "max-w-screen-2xl"
}: {
  children: React.ReactNode;
  /** Match the layout's content max-width so the bar row lines up. */
  maxWidth?: string;
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [count, setCount] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const register = useCallback(() => setCount((c) => c + 1), []);
  const unregister = useCallback(() => setCount((c) => Math.max(0, c - 1)), []);
  const active = count > 0;
  const value = useMemo(() => ({ target, register, unregister }), [target, register, unregister]);

  return (
    <ActionBarCtx.Provider value={value}>
      {/* Bottom padding only while a bar is showing, so its content never
          sits behind the fixed bar. */}
      <div className={active ? "pb-[84px]" : ""}>{children}</div>
      {mounted &&
        createPortal(
          <div
            className={`fixed inset-x-0 bottom-0 z-40 border-t border-[#E4D8C4] bg-white/95 backdrop-blur-sm shadow-[0_-4px_20px_rgba(58,39,22,0.07)] ${active ? "" : "hidden"}`}
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            <div ref={setTarget} className={`${maxWidth} mx-auto w-full`} />
          </div>,
          document.body
        )}
    </ActionBarCtx.Provider>
  );
}

export default function ActionBar({
  left,
  children
}: {
  /** Left-side context — record name, running totals, status. */
  left?: React.ReactNode;
  /** Right-side action buttons. */
  children: React.ReactNode;
}) {
  const ctx = useContext(ActionBarCtx);
  const register = ctx?.register;
  const unregister = ctx?.unregister;
  useEffect(() => {
    register?.();
    return () => unregister?.();
  }, [register, unregister]);

  if (!ctx?.target) return null;
  return createPortal(
    <div className="flex items-center gap-3 px-4 py-3">
      {left && <div className="min-w-0 flex-1 text-sm text-slate-500 truncate">{left}</div>}
      {!left && <div className="flex-1" />}
      <div className="flex items-center gap-2 flex-shrink-0">{children}</div>
    </div>,
    ctx.target
  );
}
