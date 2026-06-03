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
        "flex-shrink-0 inline-flex items-center justify-center h-10 w-10 rounded-lg text-2xl leading-none border " +
        (dark
          ? "text-white border-white/25 bg-white/10 hover:bg-white/20"
          : "text-slate-700 border-slate-300 bg-white hover:bg-slate-100") +
        " disabled:opacity-50"
      }
    >
      <span className={pending ? "inline-block animate-spin" : "inline-block"}>⟳</span>
    </button>
  );
}
