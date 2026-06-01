"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { apiUrl } from "@/lib/url";
import { STAGE_META, type ApplicationStage } from "@/lib/recruita";
import "@/lib/liff-types";

// Candidate-facing application-status page.
//
// Lifecycle:
//   1. <Script> loads LIFF SDK from LINE's CDN.
//   2. onLoad → liff.init({ liffId }) → if logged-in, getProfile()
//      → setLineUserId(profile.userId).
//   3. With a userId in hand, POST /api/recruita/my-applications
//      and render the result.
//
// We deliberately render meaningful UI in every state:
//   - "กำลังเชื่อมต่อ LINE…" while LIFF initialises.
//   - "เปิดผ่าน LINE OA เท่านั้น" when LIFF is misconfigured or the
//     user is on a desktop browser without LINE.
//   - "ยังไม่มีใบสมัคร" with a CTA to /recruita/positions when the
//     LINE account isn't linked to any candidate row.
//   - The actual stage cards when we have data.

type AppRow = {
  application_id: number;
  stage: ApplicationStage;
  submitted_at: string;
  position_title: string;
  position_code: string | null;
  branch_name: string | null;
  department: string | null;
};

type LoadState =
  | { kind: "boot" }            // before LIFF init
  | { kind: "no_liff" }         // LIFF not configured by admin
  | { kind: "outside_line" }    // opened in plain browser, no LINE auth
  | { kind: "loading" }         // have userId, fetching
  | { kind: "loaded"; rows: AppRow[]; userId: string }
  | { kind: "error"; message: string };

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return iso;
  }
}

export default function StatusClient({ liffId }: { liffId: string | null }) {
  const [state, setState] = useState<LoadState>(
    liffId ? { kind: "boot" } : { kind: "no_liff" }
  );
  const liffStarted = useRef(false);

  async function bootLiff() {
    if (!liffId || liffStarted.current) return;
    liffStarted.current = true;
    const w = window as unknown as { liff?: typeof window.liff };
    if (!w.liff) {
      setState({ kind: "no_liff" });
      return;
    }
    try {
      await w.liff.init({ liffId });
      // Outside LINE / not logged in → ask LIFF to login. In LINE
      // in-app browser this is a no-op (already logged in).
      if (!w.liff.isLoggedIn()) {
        // Trigger LINE login redirect. After consent the user lands
        // back here and bootLiff runs again with isLoggedIn() true.
        w.liff.login();
        return;
      }
      const profile = await w.liff.getProfile();
      if (!profile?.userId) {
        setState({ kind: "outside_line" });
        return;
      }
      setState({ kind: "loading" });
      const r = await fetch(apiUrl("/api/recruita/my-applications"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ line_user_id: profile.userId })
      });
      const data = (await r.json()) as { ok?: boolean; applications?: AppRow[]; error?: string };
      if (!data.ok) {
        setState({ kind: "error", message: data.error ?? "lookup_failed" });
        return;
      }
      setState({
        kind: "loaded",
        rows: data.applications ?? [],
        userId: profile.userId
      });
    } catch (e) {
      console.warn("[recruita/status] LIFF init failed:", e);
      setState({ kind: "outside_line" });
    }
  }

  // If LIFF id is present but the SDK script has already loaded
  // (e.g. client navigated here from another page), kick off init
  // ourselves on mount.
  useEffect(() => {
    if (!liffId) return;
    const w = window as unknown as { liff?: typeof window.liff };
    if (w.liff) bootLiff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liffId]);

  return (
    <div className="min-h-screen bg-amber-50/40 py-6 px-4">
      {liffId && (
        <Script
          src="https://static.line-scdn.net/liff/edge/2/sdk.js"
          strategy="afterInteractive"
          onLoad={bootLiff} />
      )}

      <main className="max-w-2xl mx-auto space-y-4">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold text-slate-800">เช็คสถานะใบสมัคร</h1>
          <p className="text-sm text-slate-500">
            My Application · IKIGAI Recruit
          </p>
        </div>

        {state.kind === "boot" && (
          <div className="card text-center text-slate-500 py-10">
            <p className="text-sm">กำลังเชื่อมต่อกับ LINE…</p>
          </div>
        )}

        {state.kind === "loading" && (
          <div className="card text-center text-slate-500 py-10">
            <p className="text-sm">กำลังค้นหาใบสมัครของคุณ…</p>
          </div>
        )}

        {state.kind === "no_liff" && (
          <div className="card text-center text-slate-600 py-10 space-y-3">
            <p className="text-base font-semibold text-slate-700">
              ระบบเช็คสถานะยังไม่พร้อมใช้งาน
            </p>
            <p className="text-xs text-slate-500">
              ผู้ดูแลระบบยังไม่ได้ตั้งค่า LIFF — กรุณาติดต่อแอดมินผ่าน LINE OA
            </p>
          </div>
        )}

        {state.kind === "outside_line" && (
          <div className="card text-center text-slate-600 py-10 space-y-3">
            <p className="text-base font-semibold text-slate-700">
              เปิดหน้านี้ผ่านแอป LINE
            </p>
            <p className="text-xs text-slate-500">
              เพื่อยืนยันตัวตนและดูสถานะใบสมัคร กรุณาเปิดลิงก์นี้จาก<br />
              Rich Menu ใน LINE OA &quot;IKIGAI Recruit&quot;
            </p>
          </div>
        )}

        {state.kind === "error" && (
          <div className="card text-center text-rose-700 bg-rose-50 border border-rose-200 py-8">
            <p className="text-sm">เกิดข้อผิดพลาด: {state.message}</p>
            <p className="text-xs mt-1 text-rose-500">ลองปิดหน้าแล้วเปิดใหม่อีกครั้ง</p>
          </div>
        )}

        {state.kind === "loaded" && state.rows.length === 0 && (
          <div className="card text-center py-10 space-y-4">
            <div className="text-slate-500">
              <p className="text-base font-semibold text-slate-700">ยังไม่มีใบสมัคร</p>
              <p className="text-xs mt-1">
                บัญชี LINE นี้ยังไม่ได้ผูกกับใบสมัครในระบบ
              </p>
            </div>
            <Link
              href="/recruita/positions"
              className="inline-block bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg">
              ดูตำแหน่งที่เปิดรับ →
            </Link>
            <div className="text-[11px] text-slate-400 space-y-2 pt-2 border-t border-slate-100">
              <p>
                ถ้าเคยสมัครแล้วแต่ไม่เห็น — อาจเป็นเพราะตอนสมัครไม่ได้ผ่าน LINE OA
              </p>
              {/* Show the LINE userId so the candidate can copy +
                  forward to an admin who'll paste it into the
                  candidate's record manually. No PII risk — userId
                  is opaque and only meaningful inside our DB. */}
              <div className="bg-slate-50 rounded-md p-2 border border-slate-200">
                <p className="text-[10px] text-slate-500 font-bold mb-1 uppercase tracking-wide">
                  LINE userId ของคุณ (ส่งให้แอดมินผูกใบสมัคร)
                </p>
                <code className="text-[10px] font-mono text-slate-700 break-all select-all block">
                  {state.userId}
                </code>
              </div>
            </div>
          </div>
        )}

        {state.kind === "loaded" && state.rows.length > 0 && (
          <section className="space-y-2">
            <p className="text-xs text-slate-500 px-1">
              พบ {state.rows.length} ใบสมัคร · เรียงจากใหม่ไปเก่า
            </p>
            {state.rows.map((row) => {
              const meta = STAGE_META[row.stage];
              return (
                <div key={row.application_id} className="card space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {row.position_code && (
                          <span className="text-[10px] font-bold uppercase tracking-wide bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded">
                            {row.position_code}
                          </span>
                        )}
                        <h3 className="font-bold text-slate-800 leading-tight">
                          {row.position_title}
                        </h3>
                      </div>
                      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-slate-500 mt-1">
                        {row.branch_name && (
                          <span className="font-semibold text-slate-700">{row.branch_name}</span>
                        )}
                        {row.department && <span>{row.department}</span>}
                      </div>
                    </div>
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap ${meta.chip}`}>
                      {meta.label}
                    </span>
                  </div>
                  <div className="border-t border-slate-100 pt-2 text-[11px] text-slate-400">
                    ส่งใบสมัครเมื่อ {fmtDate(row.submitted_at)}
                  </div>
                </div>
              );
            })}
            <div className="text-center pt-2">
              <Link
                href="/recruita/positions"
                className="text-xs text-emerald-700 hover:text-emerald-900 underline">
                ดูตำแหน่งงานอื่น
              </Link>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
