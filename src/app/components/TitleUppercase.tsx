"use client";

import { useEffect } from "react";

// Forces the browser-tab title (document.title) to an ALL-UPPERCASE,
// ASCII-only string on every page, including App-Router soft
// navigations.
//
// Why observe <head> (not just the <title> node): on a client-side
// navigation Next.js REPLACES the <title> element rather than editing
// its text. A MutationObserver bound to the old node goes dead after
// that swap, so the new (Thai / mixed-case) title slips through. We
// observe document.head with subtree:true so a replaced <title> is
// still caught and re-formatted.
//
// Thai has no upper/lower case, so a plain toUpperCase() left the tab
// half-cased ("เข้าระบบ · IKIGAI OS"). We unify separators to an
// ASCII pipe, strip every non-ASCII char (Thai etc.), uppercase, then
// rejoin the surviving Latin segments — falling back to the brand so
// the tab is always a clean uppercase Latin string
// (e.g. "เข้าระบบ · IKIGAI OS" -> "IKIGAI OS",
//  "Admin · IKIGAI OS" -> "ADMIN - IKIGAI OS").
function formatTitle(raw: string): string {
  const cleaned = raw
    // Common separators (·, |, /, en/em dash, hyphen) -> ASCII pipe
    // so we can keep segment boundaries after stripping non-ASCII.
    .replace(/[·|/–—-]+/g, "|")
    // Anything outside printable ASCII (Thai, NBSP, symbols) -> gone.
    .replace(/[^\x20-\x7E]+/g, "")
    .toUpperCase()
    .split("|")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" - ");
  return cleaned || "IKIGAI OS";
}

export default function TitleUppercase() {
  useEffect(() => {
    const apply = () => {
      const cur = document.title;
      const next = formatTitle(cur);
      // Guard against the observer reacting to its own write.
      if (cur !== next) document.title = next;
    };

    apply();
    // Observe the whole <head>: catches both in-place title edits and
    // full <title> element replacement done by Next on soft nav.
    const obs = new MutationObserver(apply);
    obs.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true
    });
    return () => obs.disconnect();
  }, []);

  return null;
}
