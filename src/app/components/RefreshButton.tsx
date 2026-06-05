"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

// Global "refresh the page data" button. Lives in the topbar so users
// running the site as an installed web-app (no browser chrome / reload
// button) can still pull fresh data. Uses router.refresh() — re-runs
// the server components without a full reload, so client state in
// open modals isn't blown away. Owner 2026-06-03.
export default function RefreshButton({
  variant = "dark"
}: { variant?: "dark" | "light" }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const dark = variant === "dark";
  return (
    <button
      type="button"
      onClick={() => startTransition(() => router.refresh())}
      disabled={pending}
      aria-label="รีเฟรชข้อมูล"
      title="รีเฟรชข้อมูล"
      className={
        "flex-shrink-0 inline-flex items-center justify-center h-10 w-10 rounded-lg border " +
        (dark
          ? "text-white border-white/25 bg-white/10 hover:bg-white/20"
          : "text-slate-700 border-slate-300 bg-white hover:bg-slate-100") +
        " disabled:opacity-50"
      }
    >
      {/* SVG circular arrow — consistent across all platforms/fonts.
          Thicker stroke (2.5px) for visibility on small screens. */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20" height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={pending ? "animate-spin" : ""}
        aria-hidden="true"
      >
        <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
    </button>
  );
}
