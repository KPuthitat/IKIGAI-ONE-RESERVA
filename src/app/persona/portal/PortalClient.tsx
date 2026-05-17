"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import OwlMascot from "../../components/OwlMascot";
import { apiUrl } from "@/lib/url";
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

export default function PortalClient({ liffId }: { liffId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("init");
  const [msg, setMsg] = useState<string>("กำลังเตรียมเข้าระบบ...");
  const [lineName, setLineName] = useState<string | null>(null);
  // Captured even when login fails — surfaced on the not_bound screen so
  // a staff member can hand their LINE userId to an admin, who pastes it
  // into the employee's "LINE binding" field. This is the robust
  // fallback for when the invite LIFF flow misbehaves (blank page, etc.)
  // since the portal LIFF itself clearly works to this point.
  const [lineUserId, setLineUserId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
        setMsg("กำลังตรวจสอบบัญชี...");

        const res = await fetch(apiUrl("/api/auth/line-login"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken })
        });

        if (cancelled) return;

        if (res.ok) {
          setPhase("ok");
          setMsg("เข้าระบบสำเร็จ กำลังพาไปหน้าหลัก...");
          // Admin-as-employee: EVERYONE who logs in via the rich-menu
          // portal lands in employee mode (/staff/persona) first —
          // including admins. An admin opts into management via the
          // "เปิดโหมดแอดมิน" switch in the sidebar. super_admin doesn't
          // reach here (no LINE binding — logs in via /login).
          setTimeout(() => router.replace("/staff/persona"), 600);
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
              บัญชี LINE ของคุณยังไม่ได้ผูกกับระบบ
            </p>

            {lineName && (
              <p className="text-xs text-slate-500">
                LINE: <span className="font-bold text-brand">{lineName}</span>
              </p>
            )}

            {lineUserId ? (
              <div className="space-y-2">
                <p className="text-xs text-slate-600">
                  ส่ง <span className="font-bold">LINE ID</span> ด้านล่างนี้
                  ให้หัวหน้างาน เพื่อผูกบัญชีให้คุณ
                </p>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs break-all select-all font-mono text-slate-700">
                  {lineUserId}
                </div>
                <button
                  type="button"
                  onClick={copyUserId}
                  className="w-full py-2 rounded-lg border border-brand text-brand text-xs font-bold hover:bg-rose-50"
                >
                  {copied ? "✓ คัดลอกแล้ว" : "📋 คัดลอก LINE ID"}
                </button>
                <p className="text-[10px] text-slate-400 leading-snug">
                  หัวหน้างานนำไปวางในช่อง "LINE binding" ของพนักงาน
                  ที่หน้า จัดการพนักงาน แล้วคุณกดปุ่มนี้อีกครั้งจะเข้าได้เลย
                </p>
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                กรุณาติดต่อหัวหน้างานเพื่อขอลิงก์เชิญลงทะเบียน
              </p>
            )}
          </div>
        )}

        {showSpinner && (
          <div className="w-56 max-w-full mx-auto pt-1">
            <div className="loadbar" />
          </div>
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
