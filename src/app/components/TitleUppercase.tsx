"use client";

import { useEffect } from "react";

// Forces the browser-tab title (document.title) to an ALL-UPPERCASE,
// Latin-only string on every page, including App-Router soft
// navigations.
//
// Why a MutationObserver instead of editing each page's metadata:
// Next.js renders <title> from per-route `metadata`, and there is no
// built-in transform for the title.template "%s". Observing the
// <title> element catches every title Next writes (initial + client
// nav) and re-formats it in one place.
//
// Thai has no upper/lower case, so a plain toUpperCase() left the tab
// looking half-cased ("เข้าระบบ · IKIGAI OS"). Per request we strip
// Thai entirely, drop now-empty separator segments, uppercase the
// rest, and fall back to the brand so the tab is always a clean
// uppercase Latin string (e.g. "เข้าระบบ · IKIGAI OS" → "IKIGAI OS",
// "PERSONA · Admin · IKIGAI OS" → "PERSONA · ADMIN · IKIGAI OS").
function formatTitle(raw: string): string {
  const cleaned = raw
    // Thai Unicode block (U+0E00–U+0E7F) → remove. Escaped form so the
    // transform is robust regardless of source file encoding.
    .replace(/[฀-๿]+/g, "")
    .toUpperCase()
    // split on common separators, drop blanks, rejoin tidily
    .split(/[·|/–—-]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" · ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "IKIGAI OS";
}

export default function TitleUppercase() {
  useEffect(() => {
    const titleEl = document.querySelector("title");
    if (!titleEl) return;

    const apply = () => {
      const cur = document.title;
      const next = formatTitle(cur);
      // Guard the observer against its own write (infinite loop).
      if (cur !== next) document.title = next;
    };

    apply();
    const obs = new MutationObserver(apply);
    obs.observe(titleEl, { childList: true, characterData: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  return null;
}
