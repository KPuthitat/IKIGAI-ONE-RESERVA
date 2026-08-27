"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

export default function LoginForm({
  next,
  error: initialError,
  lineLoginEnabled
}: { next?: string; error?: string; lineLoginEnabled?: boolean }) {
  const router = useRouter();
  const { t } = useLang();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(initialError ?? null);

  // Self-service password reset (owner 2026-07-02) — an inline panel so the
  // staff never leaves the login screen. Submitting always shows the same
  // "if it exists we sent a link" confirmation (no account-enumeration).
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotId, setForgotId] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotDone, setForgotDone] = useState(false);

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault();
    setForgotBusy(true);
    try {
      await fetch(apiUrl("/api/auth/forgot"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: forgotId })
      }).catch(() => {});
      setForgotDone(true);
    } finally {
      setForgotBusy(false);
    }
  }

  const lineStartUrl = apiUrl(
    `/api/auth/line/start${next ? `?next=${encodeURIComponent(next)}` : ""}`
  );
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
      // Always route through the branch picker so an active branch is set
      // (it auto-skips for single-branch users). When a deep-link target is
      // present (a tapped LINE card → /login?next=…), pass it through the
      // picker so it forwards there after the branch is chosen — instead of
      // jumping straight to a page that would then demand a branch.
      const pickerBase = data.is_super_admin
        ? "/admin/branch-picker"
        : (data.branchCount ?? 0) >= 1
          ? "/staff/branch-picker"
          : "/staff";
      const dest = next ? `${pickerBase}?next=${encodeURIComponent(next)}` : pickerBase;
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
          <p className="text-[11px] text-slate-400 mt-1">
            ใช้ username หรือ เลขบัตรประชาชน 13 หลัก
          </p>
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
                ? "ขอบคุณสำหรับการทำงานที่ผ่านมา"
                : accountNotice.kind === "disabled"
                  ? "บัญชีถูกปิดใช้งาน"
                  : "ยังไม่ได้ตั้งค่าครั้งแรก"}
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

      {/* Forgot password — inline, never leaves the page. */}
      {!forgotOpen ? (
        <button
          type="button"
          onClick={() => { setForgotOpen(true); setForgotDone(false); setForgotId(username); }}
          className="mt-3 text-xs text-slate-500 underline hover:text-brand"
        >
          ลืมรหัสผ่าน / เข้าไม่ได้?
        </button>
      ) : (
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          {forgotDone ? (
            <div className="text-xs text-slate-700 leading-relaxed">
              ถ้ามีบัญชีที่ผูก LINE ไว้ ระบบได้ส่ง<b>ลิงก์ตั้งรหัสใหม่ไปที่ LINE</b>แล้ว
              กรุณาเปิดแอป LINE แล้วกดลิงก์เพื่อตั้ง username / รหัสผ่าน / PIN ใหม่
              <div className="mt-2 text-[11px] text-slate-500">
                ไม่ได้รับลิงก์? แปลว่าบัญชียังไม่ได้ผูก LINE — กรุณาติดต่อแอดมิน
              </div>
              <button type="button" onClick={() => setForgotOpen(false)}
                className="mt-2 text-xs text-brand underline">ปิด</button>
            </div>
          ) : (
            <form onSubmit={submitForgot}>
              <label className="label !text-xs">ตั้งรหัสใหม่ผ่าน LINE</label>
              <p className="text-[11px] text-slate-500 mb-1.5">
                กรอก username หรือเลขบัตรประชาชน 13 หลัก — ระบบจะส่งลิงก์ไป LINE ที่ผูกไว้
              </p>
              <input
                className="input" required value={forgotId}
                onChange={(e) => setForgotId(e.target.value)}
                placeholder="username หรือ เลขบัตรประชาชน"
              />
              <div className="flex gap-2 mt-2">
                <button type="button" onClick={() => setForgotOpen(false)}
                  className="flex-1 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs">
                  ยกเลิก
                </button>
                <button type="submit" disabled={forgotBusy || !forgotId.trim()}
                  className="flex-1 py-2 rounded-lg bg-brand text-white text-xs font-bold disabled:opacity-50">
                  {forgotBusy ? "กำลังส่ง…" : "ส่งลิงก์ไป LINE"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* One-tap LINE login — only when the LINE Login channel is configured. */}
      {lineLoginEnabled && (
        <>
          <div className="flex items-center gap-3 my-4">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="text-[11px] text-slate-400">หรือ</span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>
          <a
            href={lineStartUrl}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-lg bg-[#06C755] text-white font-bold text-sm hover:opacity-90"
          >
            <span aria-hidden style={{ fontWeight: 800 }}>LINE</span>
            เข้าสู่ระบบด้วย LINE
          </a>
          <p className="text-[11px] text-slate-400 text-center mt-1.5">
            แตะครั้งเดียว ไม่ต้องจำรหัส (สำหรับบัญชีที่ผูก LINE ไว้แล้ว)
          </p>
        </>
      )}
    </>
  );
}
