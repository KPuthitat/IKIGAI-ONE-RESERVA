"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import OwlMascot from "../../components/OwlMascot";
import "@/lib/liff-types";

const STORAGE_KEY_USER_ID = "invite_line_user_id";
const STORAGE_KEY_NAME = "invite_line_name";

// LIFF gotcha — when a staff opens `https://liff.line.me/<id>?token=ABC`,
// LINE's wrapper sometimes forwards them to the endpoint URL with the
// original query wrapped inside `?liff.state=%3Ftoken%3DABC` (URL-encoded)
// instead of preserving `?token=ABC` directly. The exact behavior depends
// on the LIFF SDK version and whether the user is in LINE in-app browser
// vs external browser. We accept both shapes so the redeem flow never
// dead-ends at "no_token" when the staff actually has a valid invite.
function extractToken(): string | null {
  if (typeof window === "undefined") return null;
  const search = new URLSearchParams(window.location.search);

  // 1) Direct case — LINE preserved `?token=ABC` as-is.
  const direct = search.get("token");
  if (direct) return direct;

  // 2) Wrapped case — LIFF stuffed the original query into `liff.state`
  //    (URL-encoded), e.g. `?liff.state=%3Ftoken%3DABC`. Decode + parse.
  const liffState = search.get("liff.state");
  if (liffState) {
    try {
      const decoded = decodeURIComponent(liffState);
      const inner = new URLSearchParams(
        decoded.startsWith("?") ? decoded.slice(1) : decoded
      );
      const t = inner.get("token");
      if (t) return t;
    } catch {
      // malformed — fall through to null
    }
  }

  return null;
}

export default function RedirectClient({ liffId }: { liffId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"init" | "no_token" | "ready" | "no_liff">("init");
  const [statusMsg, setStatusMsg] = useState<string>("");

  useEffect(() => {
    const token = extractToken();
    if (!token) {
      setStatus("no_token");
      return;
    }
    let cancelled = false;
    setStatusMsg("กำลังเตรียมการเชื่อม LINE...");

    // Polling guard — the LIFF SDK script loads via next/script with
    // strategy=beforeInteractive, but on slow mobile networks it can
    // still race with this effect. Wait up to 10s for window.liff to
    // appear; after that, give up and forward without LIFF (manual
    // form fallback).
    let attempts = 0;
    const t = setInterval(async () => {
      if (cancelled) return;
      attempts += 1;
      const liff = typeof window !== "undefined" ? window.liff : undefined;
      if (!liff) {
        if (attempts > 20) {
          clearInterval(t);
          setStatus("no_liff");
          setStatusMsg("เปิดในเบราว์เซอร์ปกติ — ข้ามไปกรอกข้อมูล");
          // Forward without LIFF after 1s so the user sees the
          // message briefly.
          setTimeout(() => router.replace(`/persona/invite/${token}`), 800);
        }
        return;
      }
      clearInterval(t);

      if (!liffId) {
        // Admin hasn't set NEXT_PUBLIC_LIFF_ID_INVITE — fall through
        // to manual form. Common during local development.
        setStatus("no_liff");
        setStatusMsg("LIFF ยังไม่ได้ตั้งค่า — ข้ามไปกรอกข้อมูล");
        setTimeout(() => router.replace(`/persona/invite/${token}`), 800);
        return;
      }

      try {
        await liff.init({ liffId });
        if (cancelled) return;
        if (!liff.isLoggedIn()) {
          // In LINE app: silent. In browser: redirect to LINE login,
          // then back here with ?token preserved by LIFF.
          liff.login();
          return;
        }
        const profile = await liff.getProfile();
        if (cancelled) return;
        sessionStorage.setItem(STORAGE_KEY_USER_ID, profile.userId);
        sessionStorage.setItem(STORAGE_KEY_NAME, profile.displayName ?? "");
        setStatus("ready");
        setStatusMsg("เชื่อม LINE สำเร็จ กำลังเปิดหน้าเชิญ...");
        router.replace(`/persona/invite/${token}`);
      } catch (e) {
        // LIFF init / profile failed — fall through to manual form.
        if (cancelled) return;
        setStatus("no_liff");
        setStatusMsg("เชื่อม LINE ไม่สำเร็จ — ข้ามไปกรอกข้อมูล");
        setTimeout(() => router.replace(`/persona/invite/${token}`), 1200);
      }
    }, 250);

    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liffId]);

  if (status === "no_token") {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-amber-50/40 p-4">
        <div className="card max-w-md w-full text-center space-y-3">
          <OwlMascot size={140} mood="thinking" className="mx-auto block" />
          <h1 className="text-xl font-bold text-slate-800">ลิงก์ไม่ถูกต้อง</h1>
          <p className="text-sm text-slate-600">
            ไม่พบ token ในลิงก์ — กรุณาขอลิงก์ใหม่จากหัวหน้างานครับ
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-amber-50/40 p-4">
      <div className="card max-w-md w-full text-center space-y-3">
        <OwlMascot size={140} mood="sleepy" className="mx-auto block" />
        <h1 className="text-lg font-bold text-slate-800">
          {status === "ready" ? "เชื่อม LINE เรียบร้อย" : "กรุณารอสักครู่"}
        </h1>
        <p className="text-sm text-slate-600">{statusMsg}</p>
        <div className="w-56 max-w-full mx-auto pt-1">
          <div className="loadbar" />
        </div>
      </div>
    </div>
  );
}
