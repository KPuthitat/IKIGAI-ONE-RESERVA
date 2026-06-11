"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

export default function LoginForm({
  next,
  error: initialError
}: { next?: string; error?: string }) {
  const router = useRouter();
  const { t } = useLang();
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
        body: JSON.stringify({ username, password })
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
      // Landing by role (owner 2026-06-11): super_admin's home is the Admin
      // Console, so they go through the ADMIN branch picker → /admin. Admins
      // and staff are employees first → STAFF branch picker → /staff. Both
      // pickers auto-skip straight through when there's only one eligible
      // branch, so single-branch users feel no extra step.
      const dest = next
        ? next
        : data.is_super_admin
          ? "/admin/branch-picker"
          : (data.branchCount ?? 0) >= 1
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
      {/* Login is unified (owner 2026-06-03) — no STAFF / ADMIN picker.
          Everyone signs in with their own credentials; the session role
          decides what they can reach. Admins land in employee view and
          flip to the admin console from the sidebar ("มุมมองผู้ดูแลระบบ"),
          so the entry point stays a single, unambiguous form. */}

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
