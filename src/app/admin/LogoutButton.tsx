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
      className="inline-flex items-center rounded-full border border-white/30 px-4 py-1 text-sm font-medium text-white/90 hover:bg-white/10 hover:text-white transition-colors"
    >{t("nav.logout")}</button>
  );
}
