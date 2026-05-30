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
  // When the login API returns a 403 with an `error_code` (resigned /
  // disabled / pending_invite), keep the secondary message so we can
  // show it in a friendlier callout instead of the plain red one-liner
  // used for ordinary auth failures. Lets the staff know to contact
  // an admin instead of guessing at why their password "stopped working".
  const [accountNotice, setAccountNotice] = useState<{
    kind: "resigned" | "disabled" | "pending_invite";
    title: string;
    message: string;
    resignedAt?: string | null;
  } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setAccountNotice(null);
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.error_code === "account_resigned"
            || data.error_code === "account_disabled"
            || data.error_code === "account_pending_invite") {
          setAccountNotice({
            kind: data.error_code === "account_resigned"
              ? "resigned"
              : data.error_code === "account_disabled"
                ? "disabled"
                : "pending_invite",
            title: data.error,
            message: data.message,
            resignedAt: data.resigned_at ?? null
          });
          return;
        }
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
      {/* role selector — pill segmented.
          Restyled 2026-05-31 for white-card host: was bg-white/[.08]
          (semi-transparent on a dark page) — now slate-100 so the
          unselected option still reads against the card. */}
      <div className="flex gap-0 bg-slate-100 border border-slate-200 rounded-xl p-1 mb-4 w-full">
        <button
          type="button"
          onClick={() => setRole("staff")}
          className={`flex-1 py-2.5 rounded-[9px] text-sm font-bold tracking-[1.5px] transition-all ${
            role === "staff"
              ? "bg-brand text-white shadow-[0_2px_8px_rgba(233,69,96,.4)]"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >STAFF</button>
        <button
          type="button"
          onClick={() => setRole("admin")}
          className={`flex-1 py-2.5 rounded-[9px] text-sm font-bold tracking-[1.5px] transition-all ${
            role === "admin"
              ? "bg-brand text-white shadow-[0_2px_8px_rgba(233,69,96,.4)]"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >ADMIN</button>
      </div>

      <div
        className={`text-slate-500 text-sm font-medium mb-4 text-center ${
          lang === "en" ? "uppercase tracking-[2px]" : ""
        }`}
      >
        {t("login.forRole", { role: role === "admin" ? t("role.adminShort") : t("role.staffShort") })}
      </div>

      {/* The form is no longer its own card — the parent <div className="card">
          on login/page.tsx is the only card. Empty form tag for semantics +
          handler binding. */}
      <form onSubmit={submit} className="w-full">
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

        {accountNotice && (
          // Account-state callout. Friendlier than the generic auth
          // error because the staff did nothing wrong — their account
          // was closed (resigned) or paused (disabled). The colour
          // shifts per kind so it doesn't feel as alarming as a red
          // password-failure box.
          <div className={`rounded-xl border-2 p-3 mb-3 space-y-1.5 ${
            accountNotice.kind === "resigned"
              ? "border-sky-300 bg-sky-50"
              : accountNotice.kind === "disabled"
                ? "border-amber-300 bg-amber-50"
                : "border-violet-300 bg-violet-50"
          }`}>
            <div className={`text-sm font-bold ${
              accountNotice.kind === "resigned"
                ? "text-sky-800"
                : accountNotice.kind === "disabled"
                  ? "text-amber-800"
                  : "text-violet-800"
            }`}>
              {accountNotice.kind === "resigned"
                ? "🌅 ขอบคุณสำหรับการทำงานที่ผ่านมา"
                : accountNotice.kind === "disabled"
                  ? "⛔ บัญชีถูกปิดใช้งาน"
                  : "✉️ ยังไม่ได้ตั้งค่าครั้งแรก"}
            </div>
            <div className="text-xs text-slate-700 leading-relaxed">
              {accountNotice.title}
            </div>
            <div className="text-[11px] text-slate-600 leading-relaxed">
              {accountNotice.message}
            </div>
          </div>
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
