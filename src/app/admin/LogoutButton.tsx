"use client";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

export default function LogoutButton() {
  const router = useRouter();
  const { t } = useLang();
  return (
    <button
      onClick={async () => {
        await fetch(apiUrl("/api/logout"), { method: "POST" });
        router.push("/login");
        router.refresh();
      }}
      aria-label={t("nav.logout")}
      title={t("nav.logout")}
      className="flex-shrink-0 inline-flex items-center justify-center h-10 w-10 rounded-xl border border-white/20 bg-white/10 text-white/90 hover:bg-white/20 hover:text-white transition-colors"
    >
      {/* Icon-only, same 40×40 footprint as refresh + language (owner 2026-08). */}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
      </svg>
    </button>
  );
}
