"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import OwlMascot from "../components/OwlMascot";
import "@/lib/liff-types";

const STORAGE_KEY_USER_ID = "invite_line_user_id";
const STORAGE_KEY_NAME = "invite_line_name";

export default function RedirectClient({ liffId }: { liffId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token");
  const [status, setStatus] = useState<"init" | "no_token" | "ready" | "no_liff">("init");
  const [statusMsg, setStatusMsg] = useState<string>("");

  useEffect(() => {
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
          setTimeout(() => router.replace(`/invite/${token}`), 800);
        }
        return;
      }
      clearInterval(t);

      if (!liffId) {
        // Admin hasn't set NEXT_PUBLIC_LIFF_ID_INVITE — fall through
        // to manual form. Common during local development.
        setStatus("no_liff");
        setStatusMsg("LIFF ยังไม่ได้ตั้งค่า — ข้ามไปกรอกข้อมูล");
        setTimeout(() => router.replace(`/invite/${token}`), 800);
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
        router.replace(`/invite/${token}`);
      } catch (e) {
        // LIFF init / profile failed — fall through to manual form.
        if (cancelled) return;
        setStatus("no_liff");
        setStatusMsg("เชื่อม LINE ไม่สำเร็จ — ข้ามไปกรอกข้อมูล");
        setTimeout(() => router.replace(`/invite/${token}`), 1200);
      }
    }, 250);

    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, liffId]);

  if (status === "no_token") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-amber-50/40 p-4">
        <div className="card max-w-md text-center space-y-3">
          <OwlMascot size={96} mood="thinking" />
          <h1 className="text-xl font-bold text-slate-800">ลิงก์ไม่ถูกต้อง</h1>
          <p className="text-sm text-slate-600">
            ไม่พบ token ในลิงก์ — กรุณาขอลิงก์ใหม่จากหัวหน้างานครับ
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-amber-50/40 p-4">
      <div className="card max-w-md text-center space-y-3">
        <OwlMascot size={96} mood="sleepy" />
        <h1 className="text-lg font-bold text-slate-800">
          {status === "ready" ? "เชื่อม LINE เรียบร้อย" : "กรุณารอสักครู่"}
        </h1>
        <p className="text-sm text-slate-600">{statusMsg}</p>
        <div className="w-12 h-1 mx-auto bg-amber-200 rounded-full overflow-hidden">
          <div className="h-full bg-amber-500 animate-pulse" />
        </div>
      </div>
    </div>
  );
}
