"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

type Role = "admin" | "staff";

export default function LoginForm({
  next,
  error: initialError
}: { next?: string; error?: string }) {
  const router = useRouter();
  const { t, lang } = useLang();
  const [role, setRole] = useState<Role>("staff");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(initialError ?? null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error || t("login.error.generic"));
        return;
      }
      // Staff with multiple branches go through the branch picker first
      // so they explicitly pick "today's branch" before doing anything.
      // Single-branch staff and admin skip straight to their landing.
      // super_admin → /admin (its own dedicated console, unchanged).
      // Everyone else — including plain admin — lands on the module
      // picker first (admin is an employee first; the Admin Console
      // is an opt-in toggle in the sidebar). Multi-branch staff still
      // pick today's branch before the picker.
      const dest = next
        ? next
        : data.is_super_admin
          ? "/admin"
          : (data.branchCount ?? 0) > 1
            ? "/staff/branch-picker"
            : "/staff";
      router.push(dest);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* role selector — pill segmented */}
      <div className="flex gap-0 bg-white/[.08] border border-white/[.15] rounded-xl p-1 mb-4 w-full max-w-sm">
        <button
          type="button"
          onClick={() => setRole("staff")}
          className={`flex-1 py-3 rounded-[9px] text-base font-bold tracking-[1.5px] transition-all ${
            role === "staff"
              ? "bg-brand text-white shadow-[0_2px_8px_rgba(233,69,96,.4)]"
              : "text-white/50"
          }`}
        >STAFF</button>
        <button
          type="button"
          onClick={() => setRole("admin")}
          className={`flex-1 py-3 rounded-[9px] text-base font-bold tracking-[1.5px] transition-all ${
            role === "admin"
              ? "bg-brand text-white shadow-[0_2px_8px_rgba(233,69,96,.4)]"
              : "text-white/50"
          }`}
        >ADMIN</button>
      </div>

      <div
        className={`text-white/80 text-lg font-light mb-5 text-center ${
          lang === "en" ? "uppercase tracking-[2px]" : ""
        }`}
      >
        {t("login.forRole", { role: role === "admin" ? t("role.adminShort") : t("role.staffShort") })}
      </div>

      <form onSubmit={submit} className="card w-full max-w-sm">
        <div className="mb-4">
          <label className="label">{t("login.username")}</label>
          <input
            className="input" required autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>

        <div className="mb-4">
          <label className="label">{t("login.password")}</label>
          <input
            type="password" className="input" required autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {err && (
          <div className="text-red-600 text-sm text-center min-h-[18px] mb-2">{err}</div>
        )}

        {busy ? (
          <div className="w-full py-3" aria-label={t("login.submitting")} role="status">
            <div className="loadbar" />
          </div>
        ) : (
          <button className="btn-primary w-full">
            {t("login.submit")}
          </button>
        )}
      </form>
    </>
  );
}
