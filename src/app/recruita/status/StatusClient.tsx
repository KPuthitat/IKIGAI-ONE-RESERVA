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
// Primary identity = the LINE binding (LIFF auto-detects the userId and
// we show that account's applications). The phone-number box is a
// SEARCH fallback — for when the page is opened outside LINE, or the
// LINE account isn't linked yet. A search binds opportunistically when
// a LINE userId is present so future stage pushes reach the candidate.

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
  health_check: "ผ่านสัมภาษณ์ — รอผลตรวจสุขภาพ",
  offered:   "มีข้อเสนองานสำหรับคุณ รอการตอบรับ",
  accepted:  "คุณได้ตอบรับข้อเสนอแล้ว",
  hired:     "รับเข้าทำงานแล้ว — ยินดีต้อนรับสู่ทีม!",
  rejected:  "ขอบคุณที่สมัคร — ครั้งนี้ยังไม่ได้ไปต่อ",
  withdrawn: "ใบสมัครถูกถอนแล้ว"
};

type LoadState =
  | { kind: "boot" }            // before LIFF init
  | { kind: "no_liff" }         // LIFF not configured / SDK absent
  | { kind: "outside_line" }    // opened in plain browser, no LINE auth
  | { kind: "loading" }         // have userId, fetching
  | { kind: "loaded"; rows: AppRow[]; userId: string | null }  // userId null = found via phone search, not LINE
  | { kind: "error"; message: string };

export default function StatusClient({ liffId }: { liffId: string | null }) {
  const [state, setState] = useState<LoadState>(
    liffId ? { kind: "boot" } : { kind: "no_liff" }
  );
  const liffStarted = useRef(false);

  // LIFF-detected LINE userId (null when not opened via LINE). Used to
  // bind opportunistically on phone-search + to authorise self-delete.
  const [lineUserId, setLineUserId] = useState<string | null>(null);

  // Phone search (fallback when not opened via LINE, or LINE has no apps)
  const [searchPhone, setSearchPhone] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  // Self-delete (only for 'applied' apps + LINE-bound accounts)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  async function handleDelete(applicationId: number) {
    if (state.kind !== "loaded" || !state.userId) return;
    const uid = state.userId;
    setDeletingId(applicationId);
    setDeleteErr(null);
    try {
      const r = await fetch(apiUrl(`/api/recruita/my-applications/${applicationId}`), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ line_user_id: uid })
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

  async function handleSearch() {
    const phone = searchPhone.trim();
    if (!phone) return;
    setSearchBusy(true);
    setSearchErr(null);
    try {
      const r = await fetch(apiUrl("/api/recruita/my-applications/link"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mobile_phone: phone,
          ...(lineUserId ? { line_user_id: lineUserId } : {})
        })
      });
      const data = (await r.json()) as { ok: boolean; error?: string; applications?: AppRow[] };
      if (!data.ok) {
        setSearchErr(
          data.error === "not_found"
            ? "ไม่พบใบสมัครที่ตรงกับเบอร์นี้ — ตรวจสอบเบอร์ที่ใช้สมัครอีกครั้ง"
            : "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"
        );
        return;
      }
      const apps = data.applications ?? [];
      if (apps.length > 0) {
        setState({ kind: "loaded", rows: apps, userId: lineUserId });
      } else {
        setSearchErr("ไม่พบใบสมัครจากเบอร์นี้ — อาจยังไม่เคยสมัคร หรือใช้เบอร์อื่น");
      }
    } catch {
      setSearchErr("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    } finally {
      setSearchBusy(false);
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
      setLineUserId(profile.userId);
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
      setState({ kind: "loaded", rows: data.applications ?? [], userId: profile.userId });
    } catch (e) {
      console.warn("[recruita/status] LIFF init failed:", e);
      setState({ kind: "outside_line" });
    }
  }

  // If LIFF id is present but the SDK script already loaded, kick off
  // init ourselves on mount.
  useEffect(() => {
    if (!liffId) return;
    const w = window as unknown as { liff?: typeof window.liff };
    if (w.liff) bootLiff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liffId]);

  // Reusable phone-search box — rendered as a fallback in the non-LINE
  // states and the "no applications" state.
  const searchBox = (
    <PhoneSearchBox
      phone={searchPhone}
      onPhone={(v) => { setSearchPhone(v); setSearchErr(null); }}
      busy={searchBusy}
      err={searchErr}
      onSearch={handleSearch}
    />
  );

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
          <div className="card py-8 space-y-4">
            <div className="text-center space-y-1">
              <p className="text-base font-semibold text-slate-700">ค้นหาสถานะใบสมัคร</p>
              <p className="text-xs text-slate-500">
                เปิดผ่าน LINE OA &quot;IKIGAI Recruit&quot; เพื่อดูอัตโนมัติ
                หรือค้นหาด้วยเบอร์โทรด้านล่าง
              </p>
            </div>
            <div className="border-t border-slate-100 pt-4">{searchBox}</div>
          </div>
        )}

        {state.kind === "outside_line" && (
          <div className="card py-8 space-y-4">
            <div className="text-center space-y-1">
              <p className="text-base font-semibold text-slate-700">เปิดผ่านแอป LINE เพื่อดูอัตโนมัติ</p>
              <p className="text-xs text-slate-500">
                หรือถ้าไม่ได้เปิดผ่าน LINE — ค้นหาใบสมัครด้วยเบอร์โทรที่ใช้สมัครได้เลย
              </p>
            </div>
            <div className="border-t border-slate-100 pt-4">{searchBox}</div>
          </div>
        )}

        {state.kind === "error" && (
          <div className="card text-center text-rose-700 bg-rose-50 border border-rose-200 py-8">
            <p className="text-sm">เกิดข้อผิดพลาด: {state.message}</p>
            <p className="text-xs mt-1 text-rose-500">ลองปิดหน้าแล้วเปิดใหม่อีกครั้ง</p>
          </div>
        )}

        {state.kind === "loaded" && state.rows.length === 0 && (
          <div className="card py-8 space-y-4">
            <div className="text-center space-y-1">
              <p className="text-base font-semibold text-slate-700">ยังไม่มีใบสมัคร</p>
              <p className="text-xs text-slate-500">
                บัญชี LINE นี้ยังไม่มีใบสมัครในระบบ
              </p>
            </div>
            <div className="text-center">
              <Link
                href="/recruita/positions"
                className="inline-block bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg">
                ดูตำแหน่งที่เปิดรับ →
              </Link>
            </div>
            <div className="border-t border-slate-100 pt-4 space-y-3">
              <p className="text-[11px] text-slate-500 text-center">
                เคยสมัครแล้วแต่ไม่เห็น? ค้นหาด้วยเบอร์ที่ใช้สมัคร
              </p>
              {searchBox}
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
              const appNo = formatApplicationNo(row.submitted_at, row.day_seq);
              // Deletable only while still 'applied' AND the viewer is
              // LINE-bound (we authorise self-delete by line_user_id).
              const canDelete = row.stage === "applied" && state.userId != null;
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

// Phone-number SEARCH box — shared across the non-LINE / no-application
// states. Looks up applications by the phone used at apply time.
function PhoneSearchBox({
  phone, onPhone, busy, err, onSearch
}: {
  phone: string;
  onPhone: (v: string) => void;
  busy: boolean;
  err: string | null;
  onSearch: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-center">
        <p className="text-xs font-semibold text-slate-700">ค้นหาใบสมัครด้วยเบอร์โทรศัพท์</p>
        <p className="text-[11px] text-slate-500 mt-1">
          กรอกเบอร์ที่ใช้ตอนสมัคร เพื่อดูสถานะใบสมัครของคุณ
        </p>
      </div>
      <input
        type="tel"
        inputMode="numeric"
        placeholder="เบอร์โทรศัพท์ เช่น 0812345678"
        value={phone}
        onChange={(e) => onPhone(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onSearch(); }}
        disabled={busy}
        className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50"
      />
      {err && <p className="text-xs text-rose-600 text-center">{err}</p>}
      <button
        type="button"
        onClick={onSearch}
        disabled={busy || phone.trim().replace(/\D/g, "").length < 9}
        className="w-full bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors">
        {busy ? "กำลังค้นหา…" : "ค้นหาใบสมัคร"}
      </button>
    </div>
  );
}
