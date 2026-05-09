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
      className="text-sm text-white/70 hover:text-white"
    >{t("nav.logout")}</button>
  );
}
