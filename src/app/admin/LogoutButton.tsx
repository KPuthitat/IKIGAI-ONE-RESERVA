"use client";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

export default function LogoutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await fetch(apiUrl("/api/logout"), { method: "POST" });
        router.push("/login");
        router.refresh();
      }}
      className="text-sm text-white/70 hover:text-white"
    >ออกจากระบบ</button>
  );
}
