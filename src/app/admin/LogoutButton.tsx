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
      className="inline-flex items-center justify-center gap-1.5 flex-shrink-0 rounded-full border border-white/30 h-10 w-10 sm:h-auto sm:w-auto sm:px-4 sm:py-1.5 text-sm font-medium text-white/90 hover:bg-white/10 hover:text-white transition-colors"
    >
      {/* Icon-only on mobile to keep the control row compact; label on sm+. */}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
      </svg>
      <span className="hidden sm:inline">{t("nav.logout")}</span>
    </button>
  );
}
