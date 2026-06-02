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
        "flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg text-lg leading-none " +
        (dark
          ? "text-white/80 hover:bg-white/10"
          : "text-slate-600 hover:bg-slate-100") +
        " disabled:opacity-50"
      }
    >
      <span className={pending ? "inline-block animate-spin" : "inline-block"}>⟳</span>
    </button>
  );
}
