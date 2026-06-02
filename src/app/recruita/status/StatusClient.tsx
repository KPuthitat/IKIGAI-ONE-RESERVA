"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { apiUrl } from "@/lib/url";
import { STAGE_META, type ApplicationStage } from "@/lib/recruita";
import { formatApplicationNo, bkkDateIso, bkkHHMM, formatLongDate } from "@/lib/time";
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
  day_seq: number;
  position_title: string;
  position_code: string | null;
  branch_name: string | null;
  department: string | null;
};

// Candidate-friendly one-liner per stage — shown under each card so the
// applicant understands what's happening / what's next.
const STAGE_DESC: Record<ApplicationStage, string> = {
  applied:   "ใบสมัครเข้าระบบแล้ว รอเจ้าหน้าที่คัดกรอง",
  screening: "อยู่ระหว่างการคัดกรองคุณสมบัติ",
  interview: "ผ่านการคัดกรอง — รอนัดหมาย/อยู่ระหว่างสัมภาษณ์",
  offered:   "มีข้อเสนองานสำหรับคุณ รอการตอบรับ",
  accepted:  "คุณได้ตอบรับข้อเสนอแล้ว",
  hired:     "รับเข้าทำงานแล้ว — ยินดีต้อนรับสู่ทีม!",
  rejected:  "ขอบคุณที่สมัคร — ครั้งนี้ยังไม่ได้ไปต่อ",
  withdrawn: "ใบสมัครถูกถอนแล้ว"
};

type LoadState =
  | { kind: "boot" }            // before LIFF init
  | { kind: "no_liff" }         // LIFF not configured by admin
  | { kind: "outside_line" }    // opened in plain browser, no LINE auth
  | { kind: "loading" }         // have userId, fetching
  | { kind: "loaded"; rows: AppRow[]; userId: string }
  | { kind: "error"; message: string };

export default function StatusClient({ liffId }: { liffId: string | null }) {
  const [state, setState] = useState<LoadState>(
    liffId ? { kind: "boot" } : { kind: "no_liff" }
  );
  const liffStarted = useRef(false);

  // Self-service phone-link form (shown when LINE account has no apps yet)
  const [linkPhone, setLinkPhone] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [linkDone, setLinkDone] = useState(false); // linked but 0 apps

  // Self-delete (only for 'applied' apps, before an admin acts on them)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  async function handleDelete(applicationId: number) {
    if (state.kind !== "loaded") return;
    setDeletingId(applicationId);
    setDeleteErr(null);
    try {
      const r = await fetch(apiUrl(`/api/recruita/my-applications/${applicationId}`), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ line_user_id: state.userId })
      });
      const data = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!r.ok || !data.ok) {
        setDeleteErr(data.message ?? "ลบไม่สำเร็จ — ลองใหม่อีกครั้ง");
        return;
      }
      setState((prev) =>
        prev.kind === "loaded"
          ? { ...prev, rows: prev.rows.filter((x) => x.application_id !== applicationId) }
          : prev
      );
      setConfirmDeleteId(null);
    } catch {
      setDeleteErr("เกิดข้อผิดพลาด กรุณาลองใหม่");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleLink() {
    if (state.kind !== "loaded") return;
    const phone = linkPhone.trim();
    if (!phone) return;
    setLinkBusy(true);
    setLinkErr(null);
    try {
      const r = await fetch(apiUrl("/api/recruita/my-applications/link"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ line_user_id: state.userId, mobile_phone: phone })
      });
      const data = (await r.json()) as {
        ok: boolean;
        error?: string;
        applications?: AppRow[];
      };
      if (!data.ok) {
        if (data.error === "not_found") {
          setLinkErr("ไม่พบข้อมูลการสมัครที่ตรงกับหมายเลขนี้ — กรุณาตรวจสอบเบอร์ที่ใช้สมัคร");
        } else if (data.error === "already_linked") {
          setLinkErr("หมายเลขนี้ถูกผูกกับบัญชี LINE อื่นแล้ว กรุณาติดต่อแอดมิน");
        } else {
          setLinkErr("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
        }
        return;
      }
      const apps = data.applications ?? [];
      if (apps.length > 0) {
        setState({ kind: "loaded", rows: apps, userId: state.userId });
      } else {
        setLinkDone(true);
      }
    } catch {
      setLinkErr("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    } finally {
      setLinkBusy(false);
    }
  }

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
          <h1 className="text-2xl font-bold text-slate-800">ตรวจสอบสถานะใบสมัคร</h1>
          <p className="text-sm text-slate-500">
            MY APPLICATION · IKIGAI RECRUIT
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

        {state.kind === "loaded" && state.rows.length === 0 && !linkDone && (
          <div className="card py-8 space-y-4">
            <div className="text-center space-y-1">
              <p className="text-base font-semibold text-slate-700">ยังไม่มีใบสมัคร</p>
              <p className="text-xs text-slate-500">
                บัญชี LINE นี้ยังไม่ได้ผูกกับใบสมัครในระบบ
              </p>
            </div>
            <div className="text-center">
              <Link
                href="/recruita/positions"
                className="inline-block bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg">
                ดูตำแหน่งที่เปิดรับ →
              </Link>
            </div>

            {/* Self-service link: returning candidate who applied before LINE binding */}
            <div className="border-t border-slate-100 pt-4 space-y-3">
              <div className="text-center">
                <p className="text-xs font-semibold text-slate-700">เคยสมัครงานแล้วแต่ไม่เห็นใบสมัคร?</p>
                <p className="text-[11px] text-slate-500 mt-1">
                  กรอกเบอร์โทรศัพท์ที่ใช้ตอนสมัคร เพื่อเชื่อมใบสมัครกับ LINE ของคุณ
                </p>
              </div>
              <input
                type="tel"
                inputMode="numeric"
                placeholder="เบอร์โทรศัพท์ เช่น 0812345678"
                value={linkPhone}
                onChange={e => { setLinkPhone(e.target.value); setLinkErr(null); }}
                onKeyDown={e => { if (e.key === "Enter") handleLink(); }}
                disabled={linkBusy}
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50"
              />
              {linkErr && (
                <p className="text-xs text-rose-600 text-center">{linkErr}</p>
              )}
              <button
                onClick={handleLink}
                disabled={linkBusy || linkPhone.trim().replace(/\D/g, "").length < 9}
                className="w-full bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors">
                {linkBusy ? "กำลังค้นหา…" : "เชื่อมใบสมัคร"}
              </button>
            </div>
          </div>
        )}

        {state.kind === "loaded" && state.rows.length === 0 && linkDone && (
          <div className="card text-center py-10 space-y-4">
            <p className="text-2xl">✓</p>
            <div>
              <p className="text-base font-semibold text-emerald-700">เชื่อมบัญชีสำเร็จแล้ว</p>
              <p className="text-xs text-slate-500 mt-1">
                พบข้อมูลของคุณในระบบแล้ว แต่ยังไม่มีใบสมัครในขณะนี้
              </p>
            </div>
            <Link
              href="/recruita/positions"
              className="inline-block bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg">
              ดูตำแหน่งที่เปิดรับ →
            </Link>
          </div>
        )}

        {state.kind === "loaded" && state.rows.length > 0 && (
          <section className="space-y-2">
            <p className="text-xs text-slate-500 px-1">
              พบ {state.rows.length} ใบสมัคร · เรียงจากใหม่ไปเก่า
            </p>
            {state.rows.map((row) => {
              const meta = STAGE_META[row.stage];
              const appNo = formatApplicationNo(row.submitted_at, row.day_seq);
              const canDelete = row.stage === "applied";
              return (
                <div key={row.application_id} className="card space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] font-mono font-bold text-slate-500">{appNo}</span>
                        {row.position_code && (
                          <span className="text-[10px] font-bold uppercase tracking-wide bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded">
                            {row.position_code}
                          </span>
                        )}
                      </div>
                      <h3 className="font-bold text-slate-800 leading-tight mt-1">
                        {row.position_title}
                      </h3>
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

                  {/* Stage description — what's happening / what's next */}
                  <div className="text-xs text-slate-600 bg-slate-50 rounded-md px-2.5 py-1.5">
                    {STAGE_DESC[row.stage]}
                  </div>

                  <div className="border-t border-slate-100 pt-2 flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[11px] text-slate-400">
                      ส่งเมื่อ {formatLongDate(bkkDateIso(row.submitted_at), "th")} · {bkkHHMM(row.submitted_at)} น.
                    </span>
                    {canDelete && confirmDeleteId !== row.application_id && (
                      <button
                        type="button"
                        onClick={() => { setConfirmDeleteId(row.application_id); setDeleteErr(null); }}
                        className="text-[11px] text-rose-600 hover:text-rose-800 underline">
                        ลบใบสมัคร
                      </button>
                    )}
                  </div>

                  {/* Inline delete confirm — only while still 'applied' */}
                  {canDelete && confirmDeleteId === row.application_id && (
                    <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 space-y-2">
                      <p className="text-xs text-rose-800">
                        ลบใบสมัครนี้? หลังลบแล้วคุณสามารถสมัครใหม่ได้
                        (ลบได้เฉพาะก่อนเจ้าหน้าที่เริ่มพิจารณาเท่านั้น)
                      </p>
                      {deleteErr && <p className="text-xs text-rose-600">{deleteErr}</p>}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleDelete(row.application_id)}
                          disabled={deletingId === row.application_id}
                          className="flex-1 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-xs font-semibold px-3 py-2 rounded-lg">
                          {deletingId === row.application_id ? "กำลังลบ…" : "ยืนยันลบ"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          disabled={deletingId === row.application_id}
                          className="flex-1 bg-white border border-slate-300 text-slate-700 text-xs font-semibold px-3 py-2 rounded-lg">
                          ยกเลิก
                        </button>
                      </div>
                    </div>
                  )}
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
