"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import OwlMascot from "../../components/OwlMascot";
import { apiUrl } from "@/lib/url";
import PortalSelfRegister from "./PortalSelfRegister";
import "@/lib/liff-types";

// Phase of the auto-login flow. Drives the visible copy + whether we
// show a manual-login CTA fallback.
type Phase =
  | "init"        // SDK loading or LIFF init in progress
  | "auth"        // verifying with backend
  | "ok"          // session created, about to redirect
  | "no_liff"     // LIFF unavailable — likely external browser
  | "not_bound"   // LINE account not registered in our users table
  | "error";      // unexpected (network, server error, etc.)

// Stable display name + userId we capture from liff.getProfile() the
// moment LIFF initialises, BEFORE attempting login. Splitting these
// out from the login-result state lets the user click "I'm new" and
// jump straight to the share-userId screen without waiting for the
// auth round-trip to fail.

// Where to land after a successful auto-login. Reads a `next` query
// param (used by deep-links such as the RECRUITA exec "ตรวจสอบใบสมัคร"
// button) and validates it's an internal absolute path — never an
// external URL (open-redirect guard). LIFF sometimes wraps the original
// query inside `liff.state`, so we check there too. Defaults to /staff.
function safeNextTarget(): string {
  if (typeof window === "undefined") return "/staff";
  const sp = new URLSearchParams(window.location.search);
  let raw = sp.get("next");
  if (!raw) {
    const state = sp.get("liff.state");
    if (state) {
      try {
        const inner = new URLSearchParams(state.startsWith("?") ? state.slice(1) : state);
        raw = inner.get("next");
      } catch { /* ignore malformed liff.state */ }
    }
  }
  // Internal path only: must start with a single "/" (block "//host").
  return raw && /^\/(?!\/)/.test(raw) ? raw : "/staff";
}

export default function PortalClient({ liffId }: { liffId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("init");
  const [msg, setMsg] = useState<string>("กำลังเตรียมเข้าระบบ");
  const [lineName, setLineName] = useState<string | null>(null);
  // Captured even when login fails — surfaced on the not_bound screen so
  // a staff member can hand their LINE userId to an admin, who pastes it
  // into the employee's "LINE binding" field. This is the robust
  // fallback for when the invite LIFF flow misbehaves (blank page, etc.)
  // since the portal LIFF itself clearly works to this point.
  const [lineUserId, setLineUserId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // New-employee self-registration toggle (owner 2026-06-16) — shown on the
  // not_bound screen so a freshly-hired employee can claim their own account
  // (national_id + dob) instead of waiting for an admin to send a link.
  const [showRegister, setShowRegister] = useState(false);

  async function copyUserId(): Promise<void> {
    if (!lineUserId) return;
    try {
      await navigator.clipboard.writeText(lineUserId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (insecure context / old in-app
      // browser). The userId is still shown in a select-all box so
      // the staff can long-press → copy manually.
    }
  }

  // LINE Share Target Picker — pops the native LINE share sheet so
  // the staff can send their userId straight to the admin without
  // copy/paste gymnastics. Requires liff.shareTargetPicker; falls
  // back silently when the LIFF channel isn't allowed to use it
  // (clipboard copy still works).
  async function shareUserIdToAdmin(): Promise<void> {
    if (!lineUserId) return;
    const liff = typeof window !== "undefined" ? window.liff : undefined;
    if (!liff?.shareTargetPicker) {
      // Fallback: just copy. User can paste in any LINE chat.
      await copyUserId();
      return;
    }
    try {
      await liff.shareTargetPicker([
        {
          type: "text",
          text:
            `ขอลงทะเบียนเข้าระบบ IKIGAI OS ครับ\n\n` +
            `LINE ID: ${lineUserId}\n\n` +
            `(แอดมินกรุณานำไปวางในช่อง "LINE binding" ของบัญชีพนักงาน)`
        }
      ]);
    } catch (e) {
      console.warn("[portal] shareTargetPicker failed, falling back to copy:", e);
      await copyUserId();
    }
  }

  // When we land in the not_bound state, auto-copy the userId once so
  // the staff is one step ahead — they can paste straight into a
  // chat without hunting for the copy button. Silent fail (insecure
  // context, old browser) is fine; the visible button is the
  // explicit path.
  useEffect(() => {
    if (phase === "not_bound" && lineUserId && !copied) {
      navigator.clipboard?.writeText(lineUserId).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2500);
        },
        () => { /* clipboard blocked — user can press the button */ }
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, lineUserId]);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;

    // Same polling guard as /persona/invite — wait up to ~5s for LIFF
    // SDK to be available on window before giving up.
    const interval = setInterval(async () => {
      if (cancelled) return;
      attempts += 1;
      const liff = typeof window !== "undefined" ? window.liff : undefined;

      if (!liff) {
        if (attempts > 20) {
          clearInterval(interval);
          setPhase("no_liff");
          setMsg("เปิดในเบราว์เซอร์ปกติ — โปรดล็อกอินด้วย username/password");
        }
        return;
      }
      clearInterval(interval);

      if (!liffId) {
        // Admin hasn't set NEXT_PUBLIC_LIFF_ID_PORTAL — common during
        // local dev. Fall through to manual login.
        setPhase("no_liff");
        setMsg("LIFF Portal ยังไม่ได้ตั้งค่า — โปรดล็อกอินด้วย username/password");
        return;
      }

      try {
        await liff.init({ liffId });
        if (cancelled) return;

        if (!liff.isLoggedIn()) {
          // In LINE in-app browser this is silent. In external browser
          // it redirects to the LINE login page, then returns here
          // already authenticated.
          liff.login();
          return;
        }

        const accessToken = liff.getAccessToken();
        if (!accessToken) {
          setPhase("no_liff");
          setMsg("ไม่สามารถดึงข้อมูล LINE ได้ — โปรดล็อกอินด้วย username/password");
          return;
        }

        // Pull displayName + userId. displayName is for friendly copy;
        // userId is the value an admin pastes into the employee's LINE
        // binding field when the not_bound fallback is used. Non-fatal
        // if it fails — the backend re-derives userId from accessToken.
        try {
          const profile = await liff.getProfile();
          if (!cancelled) {
            setLineName(profile.displayName ?? null);
            setLineUserId(profile.userId ?? null);
          }
        } catch {
          // ignore
        }

        setPhase("auth");
        setMsg("กำลังตรวจสอบบัญชี");

        const res = await fetch(apiUrl("/api/auth/line-login"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken })
        });

        if (cancelled) return;

        if (res.ok) {
          setPhase("ok");
          setMsg("เข้าระบบสำเร็จ กำลังพาไปหน้าหลัก");
          // Honour a `next` deep-link target (e.g. the RECRUITA exec
          // "ตรวจสอบใบสมัคร" button → application detail). Defaults to
          // the /staff module picker. Admins are employees first; they
          // opt into management via the Admin Console toggle.
          const next = safeNextTarget();
          setTimeout(() => router.replace(next), 600);
          return;
        }

        if (res.status === 404) {
          // LINE userId is real but no user has it bound — staff
          // hasn't been onboarded yet, or admin hasn't sent the
          // invite link. Show a helpful message instead of generic
          // "login failed".
          setPhase("not_bound");
          setMsg("บัญชี LINE นี้ยังไม่ได้ลงทะเบียนในระบบ");
          return;
        }

        setPhase("error");
        setMsg("ไม่สามารถเข้าระบบได้ — กรุณาลองใหม่หรือใช้ username/password");
      } catch {
        if (cancelled) return;
        setPhase("no_liff");
        setMsg("เชื่อม LINE ไม่สำเร็จ — โปรดล็อกอินด้วย username/password");
      }
    }, 250);

    return () => { cancelled = true; clearInterval(interval); };
  }, [liffId, router]);

  // Manual /login CTA is shown ONLY for environmental failures
  // (no_liff / error) where a legitimate admin opening the rich-menu
  // link in a desktop browser might still want to get in. We deliberately
  // do NOT show it for `not_bound` — that's an identity check failure
  // (the LIFF userId isn't registered in our users table), and per
  // policy unregistered staff must not be able to enter the system at
  // all. They see only "ติดต่อหัวหน้างาน" with no actionable button.
  const showManualLoginCta = phase === "no_liff" || phase === "error";
  const showSpinner = phase === "init" || phase === "auth" || phase === "ok";

  const heading =
    phase === "ok" ? "เข้าระบบสำเร็จ" :
    phase === "not_bound" ? "ไม่สามารถเข้าระบบได้" :
    phase === "no_liff" ? "เปิดในเบราว์เซอร์ปกติ" :
    phase === "error" ? "ไม่สามารถเข้าระบบได้" :
    "กรุณารอสักครู่";

  const mascotMood: "smile" | "thinking" | "sleepy" =
    phase === "ok" ? "smile" :
    phase === "not_bound" ? "thinking" :
    "sleepy";

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-amber-50/40 p-4">
      <div className="card max-w-md w-full text-center space-y-3">
        <OwlMascot size={140} mood={mascotMood} className="mx-auto block" />
        <h1 className="text-lg font-bold text-slate-800">{heading}</h1>

        {lineName && phase !== "not_bound" && (
          <p className="text-xs text-slate-500">
            LINE: <span className="font-bold text-brand">{lineName}</span>
          </p>
        )}

        <p className="text-sm text-slate-600">{msg}</p>

        {phase === "not_bound" && (
          <div className="space-y-3 pt-1">
            <p className="text-sm text-slate-700 font-medium">
              บัญชี LINE ของคุณยังไม่ได้เชื่อมต่อกับระบบ
            </p>

            {lineName && (
              <p className="text-xs text-slate-500">
                LINE: <span className="font-bold text-brand">{lineName}</span>
              </p>
            )}

            {showRegister ? (
              <>
                <PortalSelfRegister
                  getAccessToken={() =>
                    (typeof window !== "undefined" && window.liff
                      ? window.liff.getAccessToken() ?? null
                      : null)}
                  onDone={() => router.replace("/staff")} />
                <button
                  type="button"
                  onClick={() => setShowRegister(false)}
                  className="block w-full py-2 text-xs text-slate-500 hover:underline"
                >
                  ← ย้อนกลับ
                </button>
              </>
            ) : (
              <>
                {/* Primary path — the new employee claims their own account */}
                <button
                  type="button"
                  onClick={() => setShowRegister(true)}
                  className="block w-full py-2.5 rounded-lg bg-brand text-white text-sm font-bold hover:bg-brand/90"
                >
                  ลงทะเบียนพนักงานใหม่ (สมัครด้วยตัวเอง)
                </button>

                {/* Fallback — hand the LINE ID to an admin to bind manually */}
                {lineUserId ? (
                  <div className="space-y-2 pt-2 border-t border-slate-100">
                    <p className="text-[11px] text-slate-400">
                      หรือ ให้แอดมินลงทะเบียนให้ — ส่ง LINE ID นี้ให้หัวหน้างาน
                    </p>
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs break-all select-all font-mono text-slate-700">
                      {lineUserId}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={copyUserId}
                        className="flex-1 py-2 rounded-lg border border-brand text-brand text-xs font-bold hover:bg-rose-50"
                      >
                        {copied ? "✓ คัดลอกแล้ว" : "คัดลอก"}
                      </button>
                      <button
                        type="button"
                        onClick={shareUserIdToAdmin}
                        className="flex-1 py-2 rounded-lg bg-slate-600 text-white text-xs font-bold hover:bg-slate-700"
                      >
                        ส่งให้แอดมิน
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 pt-1">
                    หรือ ติดต่อหัวหน้างานเพื่อลงทะเบียนให้
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {showSpinner && (
          <div className="w-56 max-w-full mx-auto pt-1">
            <div className="loadbar" />
          </div>
        )}

        {/* "I'm a new employee" escape hatch — visible while we're
            still spinning. Lets the user skip the login attempt and
            jump straight to the userId-share screen. Hidden the
            moment we land on a definitive phase. Only shows once
            lineUserId is captured so the share screen has something
            to display. */}
        {showSpinner && lineUserId && (
          <button
            type="button"
            onClick={() => {
              setPhase("not_bound");
              setMsg("ส่ง LINE ID ด้านล่างให้แอดมิน");
            }}
            className="block w-full mt-2 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs font-medium hover:bg-slate-50"
          >
            ฉันเป็นพนักงานใหม่ — ขอ LINE ID ให้แอดมินลงทะเบียน
          </button>
        )}

        {showManualLoginCta && (
          <Link
            href="/login"
            className="block w-full py-2.5 rounded-lg bg-brand text-white text-sm font-bold"
          >
            เข้าระบบด้วย username/password
          </Link>
        )}
      </div>
    </div>
  );
}
