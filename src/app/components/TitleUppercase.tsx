"use client";

import { useEffect } from "react";

// Forces the browser-tab title (document.title) to UPPERCASE on every
// page, including App-Router soft navigations.
//
// Why a MutationObserver instead of editing each page's metadata:
// Next.js renders <title> from per-route `metadata`, and there is no
// built-in transform for the title.template "%s". Observing the <title>
// element catches every title Next writes (initial + client nav) and
// re-cases it in one place. Thai characters have no case so
// toUpperCase() is a harmless no-op for them — only Latin/numeric
// brand text is affected, which is exactly the intent.
export default function TitleUppercase() {
  useEffect(() => {
    const titleEl = document.querySelector("title");
    if (!titleEl) return;

    const apply = () => {
      const cur = document.title;
      const up = cur.toUpperCase();
      // Guard the observer against its own write (infinite loop).
      if (cur !== up) document.title = up;
    };

    apply();
    const obs = new MutationObserver(apply);
    obs.observe(titleEl, { childList: true, characterData: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  return null;
}
