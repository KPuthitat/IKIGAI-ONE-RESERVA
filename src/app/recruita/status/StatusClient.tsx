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
  /** Current interview booking (naive Bangkok-local "YYYY-MM-DDTHH:MM"),
   *  null until the applicant self-books a slot. */
  interview_at: string | null;
  interview_location: string | null;
  /** Offer detail at the 'offered' stage (owner 2026-06-15). */
  offer_salary: number | null;
  offer_salary_type: "monthly" | "hourly" | null;
  offer_start_date: string | null;
};

// A bookable interview slot from /api/recruita/interview-slots/available.
type BookableSlot = {
  id: number;
  slot_date: string;
  start_time: string;
  end_time: string;
  location: string | null;
  status: "open" | "booked";
};

// Thai weekday short names, indexed by JS getUTCDay().
const WD_TH = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

function weekdayTh(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return WD_TH[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
}

/** Format a naive "YYYY-MM-DDTHH:MM" booking into Thai text. */
function fmtBookingWhen(at: string): string {
  const [d, tm] = at.split("T");
  const time = (tm ?? "").slice(0, 5);
  const datePart = /^\d{4}-\d{2}-\d{2}$/.test(d ?? "") ? formatLongDate(d, "th") : (d ?? at);
  return time ? `${datePart} เวลา ${time} น.` : datePart;
}

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

  // ── Self-service interview booking ──────────────────────────────
  // slots === null → not yet fetched. bookingFor holds the
  // application_id whose slot picker is currently open.
  const [slots, setSlots] = useState<BookableSlot[] | null>(null);
  const [bookingFor, setBookingFor] = useState<number | null>(null);
  const [bookingSlotId, setBookingSlotId] = useState<number | null>(null);
  const [bookErr, setBookErr] = useState<string | null>(null);
  // A slot the applicant tapped but hasn't confirmed yet (owner 2026-06-11:
  // "กดเลือกเวลาแล้วควรมีปุ่มยืนยันก่อน"). window.confirm is unreliable inside
  // LINE's in-app browser, so booking is a two-step in-page flow instead.
  const [pendingSlot, setPendingSlot] = useState<BookableSlot | null>(null);
  // Cancel-booking flow ("ยกเลิกได้เพื่อปล่อยคิวให้คนอื่น").
  const [cancelConfirmFor, setCancelConfirmFor] = useState<number | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);

  async function loadSlots() {
    try {
      const r = await fetch(apiUrl("/api/recruita/interview-slots/available"));
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; slots?: BookableSlot[] };
      setSlots(j.ok ? (j.slots ?? []) : []);
    } catch {
      setSlots([]);
    }
  }

  // Identity proof for booking — LINE userId (LIFF) and/or the phone
  // used to search. The server requires at least one to match the
  // application's candidate.
  function bookingIdentity(): { line_user_id?: string; mobile_phone?: string } {
    const id: { line_user_id?: string; mobile_phone?: string } = {};
    if (state.kind === "loaded" && state.userId) id.line_user_id = state.userId;
    const phone = searchPhone.trim();
    if (phone) id.mobile_phone = phone;
    return id;
  }

  async function bookSlot(applicationId: number, slot: BookableSlot) {
    setBookingSlotId(slot.id);
    setBookErr(null);
    try {
      const r = await fetch(apiUrl(`/api/recruita/interview-slots/${slot.id}/book`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ application_id: applicationId, ...bookingIdentity() })
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; message?: string;
        interview_at?: string; location?: string | null;
      };
      if (!r.ok || !j.ok) {
        setBookErr(j.message ?? "จองไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
        if (j.error === "slot_taken") { setPendingSlot(null); void loadSlots(); } // someone took it — refresh
        return;
      }
      // Reflect the booking on the row + close the picker + refresh slots.
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              ...prev,
              rows: prev.rows.map((x) =>
                x.application_id === applicationId
                  ? { ...x, interview_at: j.interview_at ?? null, interview_location: j.location ?? null }
                  : x)
            }
          : prev);
      setBookingFor(null);
      setPendingSlot(null);
      void loadSlots();
    } catch {
      setBookErr("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    } finally {
      setBookingSlotId(null);
    }
  }

  // Cancel a confirmed booking → frees the slot for others (owner 2026-06-11).
  async function cancelBooking(applicationId: number) {
    setCancelBusy(true);
    setCancelErr(null);
    try {
      const r = await fetch(apiUrl("/api/recruita/interview-slots/cancel"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ application_id: applicationId, ...bookingIdentity() })
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean };
      if (!r.ok || !j.ok) { setCancelErr("ยกเลิกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"); return; }
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              ...prev,
              rows: prev.rows.map((x) =>
                x.application_id === applicationId
                  ? { ...x, interview_at: null, interview_location: null }
                  : x)
            }
          : prev);
      setCancelConfirmFor(null);
      setBookingFor(null);
      setPendingSlot(null);
      void loadSlots();
    } catch {
      setCancelErr("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    } finally {
      setCancelBusy(false);
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

  // Lazy-load interview slots once the loaded result includes an
  // application at the 'interview' stage (the only stage that can book).
  useEffect(() => {
    if (state.kind !== "loaded" || slots !== null) return;
    if (state.rows.some((r) => r.stage === "interview")) void loadSlots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, slots]);

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

                  {/* Self-service interview booking — only while at the
                      'interview' stage (the team has invited them to pick
                      a time). Shows their current booking + lets them
                      pick / change a 1-hour slot the admin opened. */}
                  {row.stage === "interview" && (
                    <div className="border border-amber-200 bg-amber-50/60 rounded-lg p-3 space-y-2">
                      {row.interview_at ? (
                        <div className="text-xs text-amber-900">
                          <span className="font-bold">นัดสัมภาษณ์ของคุณ:</span>{" "}
                          {fmtBookingWhen(row.interview_at)}
                          {row.interview_location ? ` · ${row.interview_location}` : ""}
                        </div>
                      ) : (
                        <div className="text-xs text-amber-900 font-semibold">
                          กรุณาเลือกวันและเวลาสัมภาษณ์ของคุณ
                        </div>
                      )}

                      {/* Picker / confirm step — open while choosing a slot. */}
                      {bookingFor === row.application_id ? (
                        pendingSlot ? (
                          // Step 2: in-page confirm (replaces window.confirm,
                          // which is unreliable inside the LINE in-app browser).
                          <div className="bg-white border border-emerald-300 rounded-lg p-3 space-y-2">
                            <div className="text-xs text-slate-700">
                              ยืนยันเลือกเวลาสัมภาษณ์:
                              <div className="font-bold text-emerald-800 mt-0.5">
                                {weekdayTh(pendingSlot.slot_date)} {formatLongDate(pendingSlot.slot_date, "th")}
                                {" "}เวลา {pendingSlot.start_time}–{pendingSlot.end_time} น.
                              </div>
                              {pendingSlot.location && (
                                <div className="text-[11px] text-slate-500 mt-0.5">สถานที่: {pendingSlot.location}</div>
                              )}
                            </div>
                            {bookErr && <p className="text-xs text-rose-600">{bookErr}</p>}
                            <div className="flex gap-2">
                              <button type="button" disabled={bookingSlotId !== null}
                                onClick={() => bookSlot(row.application_id, pendingSlot)}
                                className="flex-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold px-3 py-2 rounded-lg">
                                {bookingSlotId !== null ? "กำลังยืนยัน…" : "ยืนยันนัดหมาย"}
                              </button>
                              <button type="button" disabled={bookingSlotId !== null}
                                onClick={() => { setPendingSlot(null); setBookErr(null); }}
                                className="flex-1 bg-white border border-slate-300 text-slate-700 text-xs font-semibold px-3 py-2 rounded-lg">
                                เลือกเวลาอื่น
                              </button>
                            </div>
                          </div>
                        ) : (
                          // Step 1: pick a slot (selecting only — no booking yet).
                          <div className="space-y-2">
                            {slots === null ? (
                              <p className="text-xs text-slate-500">กำลังโหลดช่วงเวลา…</p>
                            ) : slots.length === 0 ? (
                              <p className="text-xs text-slate-500">
                                ยังไม่มีช่วงเวลาว่างให้เลือกในขณะนี้ — กรุณาติดต่อเจ้าหน้าที่
                              </p>
                            ) : (
                              <SlotPicker
                                slots={slots}
                                onPick={(slot) => { setPendingSlot(slot); setBookErr(null); }} />
                            )}
                            <button type="button"
                              onClick={() => { setBookingFor(null); setBookErr(null); setPendingSlot(null); }}
                              className="text-[11px] text-slate-500 underline">
                              ปิด
                            </button>
                          </div>
                        )
                      ) : cancelConfirmFor === row.application_id ? (
                        // Cancel confirm — releases the slot back to the queue.
                        <div className="bg-white border border-rose-200 rounded-lg p-3 space-y-2">
                          <p className="text-[11px] text-rose-800">
                            ยกเลิกนัดสัมภาษณ์นี้? ช่วงเวลาจะถูกปล่อยคืนให้ผู้สมัครคนอื่นเลือกได้
                          </p>
                          {cancelErr && <p className="text-[11px] text-rose-600">{cancelErr}</p>}
                          <div className="flex gap-2">
                            <button type="button" disabled={cancelBusy}
                              onClick={() => cancelBooking(row.application_id)}
                              className="flex-1 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-xs font-bold px-3 py-2 rounded-lg">
                              {cancelBusy ? "กำลังยกเลิก…" : "ยืนยันยกเลิกนัด"}
                            </button>
                            <button type="button" disabled={cancelBusy}
                              onClick={() => { setCancelConfirmFor(null); setCancelErr(null); }}
                              className="flex-1 bg-white border border-slate-300 text-slate-700 text-xs font-semibold px-3 py-2 rounded-lg">
                              ไม่ยกเลิก
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2 flex-wrap">
                          <button type="button"
                            onClick={() => {
                              setBookingFor(row.application_id);
                              setBookErr(null);
                              setPendingSlot(null);
                              if (slots === null) void loadSlots();
                            }}
                            className="text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-lg">
                            {row.interview_at ? "เปลี่ยนวันเวลา" : "เลือกวันเวลาสัมภาษณ์"}
                          </button>
                          {row.interview_at && (
                            <button type="button"
                              onClick={() => { setCancelConfirmFor(row.application_id); setCancelErr(null); }}
                              className="text-xs font-semibold border border-rose-300 text-rose-600 hover:bg-rose-50 px-3 py-1.5 rounded-lg">
                              ยกเลิกนัด (ปล่อยคิว)
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Health-check upload — only while waiting on the
                      medical check. Applicant uploads the 5-disease cert
                      photo/PDF (owner 2026-06-14); it lands as a
                      health_result document the admin form surfaces. */}
                  {row.stage === "health_check" && (
                    <HealthCertUpload
                      applicationId={row.application_id}
                      identity={bookingIdentity()} />
                  )}

                  {/* Job offer — accept / reject (owner 2026-06-15) */}
                  {row.stage === "offered" && (
                    <OfferResponse
                      row={row}
                      identity={bookingIdentity()}
                      onResponded={(stage) =>
                        setState((prev) =>
                          prev.kind === "loaded"
                            ? { ...prev, rows: prev.rows.map((x) => x.application_id === row.application_id ? { ...x, stage } : x) }
                            : prev)
                      } />
                  )}

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

// Health-certificate upload — shown on a health_check-stage card. The
// applicant picks a photo/PDF of their 5-disease medical certificate and
// uploads it; the server stores it as a health_result document the admin
// form picks up. A fresh upload replaces the previous one server-side.
function HealthCertUpload({
  applicationId, identity
}: {
  applicationId: number;
  identity: { line_user_id?: string; mobile_phone?: string };
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    if (!identity.line_user_id && !identity.mobile_phone) {
      setErr("ไม่พบข้อมูลยืนยันตัวตน — เปิดผ่าน LINE หรือค้นหาด้วยเบอร์โทรก่อน");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (identity.line_user_id) fd.append("line_user_id", identity.line_user_id);
      if (identity.mobile_phone) fd.append("mobile_phone", identity.mobile_phone);
      const r = await fetch(apiUrl(`/api/recruita/my-applications/${applicationId}/health-cert`), {
        method: "POST",
        body: fd
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!r.ok || !j.ok) {
        setErr(j.message ?? "อัพโหลดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
        return;
      }
      setDone(true);
      setFile(null);
    } catch {
      setErr("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-teal-200 bg-teal-50/60 rounded-lg p-3 space-y-2">
      <div className="text-xs text-teal-900 font-semibold">
        อัพโหลดใบรับรองแพทย์ 5 โรค
      </div>
      <p className="text-[11px] text-teal-800/80 leading-relaxed">
        ถ่ายรูปหรือสแกนใบรับรองแพทย์ (รองรับรูปภาพหรือ PDF ไม่เกิน 10MB)
        แล้วอัพโหลดที่นี่ · ใบรับรองตัวจริงให้นำมายื่นที่บริษัทในวันแรกที่มาทำงาน
      </p>
      {done ? (
        <div className="bg-white border border-emerald-300 rounded-lg p-3 space-y-2">
          <p className="text-xs text-emerald-800 font-semibold">
            อัพโหลดเรียบร้อยแล้ว — เจ้าหน้าที่จะตรวจสอบและแจ้งผลให้ทราบ
          </p>
          <button type="button"
            onClick={() => { setDone(false); setErr(null); }}
            className="text-[11px] text-teal-700 underline">
            อัพโหลดใหม่อีกครั้ง
          </button>
        </div>
      ) : (
        <>
          <input
            type="file"
            accept=".pdf,image/*"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setErr(null); }}
            disabled={busy}
            className="text-xs w-full" />
          {file && <p className="text-[11px] text-teal-700">{file.name}</p>}
          {err && <p className="text-[11px] text-rose-600">{err}</p>}
          <button type="button"
            onClick={upload}
            disabled={busy || !file}
            className="bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-xs font-bold px-4 py-2 rounded-lg">
            {busy ? "กำลังอัพโหลด…" : "อัพโหลดใบรับรองแพทย์"}
          </button>
        </>
      )}
    </div>
  );
}

// Job-offer accept/reject (owner 2026-06-15). Shown on an 'offered'-stage
// card: the candidate sees the position + compensation + start date and
// accepts (→ accepted, waits for the admin to hire) or rejects (→ withdrawn).
// Two-step confirm because window.confirm is unreliable in LINE's browser.
function OfferResponse({
  row, identity, onResponded
}: {
  row: AppRow;
  identity: { line_user_id?: string; mobile_phone?: string };
  onResponded: (stage: ApplicationStage) => void;
}) {
  const [step, setStep] = useState<"view" | "confirm_accept" | "confirm_reject" | "done">("view");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function respond(action: "accept" | "reject") {
    if (!identity.line_user_id && !identity.mobile_phone) {
      setErr("ไม่พบข้อมูลยืนยันตัวตน — เปิดผ่าน LINE หรือค้นหาด้วยเบอร์โทรก่อน");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(apiUrl(`/api/recruita/my-applications/${row.application_id}/offer-response`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...identity })
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!r.ok || !j.ok) { setErr(j.message ?? "ทำรายการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"); return; }
      setStep("done");
      onResponded(action === "accept" ? "accepted" : "withdrawn");
    } catch {
      setErr("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  const unit = row.offer_salary_type === "hourly" ? "บาท/ชม." : "บาท/เดือน";

  return (
    <div className="border border-violet-200 bg-violet-50/60 rounded-lg p-3 space-y-2">
      <div className="text-xs text-violet-900 font-bold">ข้อเสนองาน</div>
      <div className="text-xs text-violet-900 space-y-0.5">
        <div>ตำแหน่ง: <b>{row.position_title}</b></div>
        {row.offer_salary != null && (
          <div>ค่าตอบแทน: <b>{row.offer_salary.toLocaleString("th-TH")} {unit}</b></div>
        )}
        {row.offer_start_date && (
          <div>เริ่มงานวันแรก: <b>{formatLongDate(row.offer_start_date, "th")}</b></div>
        )}
      </div>
      {err && <p className="text-[11px] text-rose-600">{err}</p>}

      {step === "done" ? (
        <p className="text-xs text-emerald-800 font-semibold">บันทึกคำตอบเรียบร้อยแล้ว — เจ้าหน้าที่จะติดต่อกลับ</p>
      ) : step === "view" ? (
        <div className="flex gap-2">
          <button type="button" onClick={() => { setStep("confirm_accept"); setErr(null); }}
            className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-3 py-2 rounded-lg">
            ตอบรับข้อเสนอ
          </button>
          <button type="button" onClick={() => { setStep("confirm_reject"); setErr(null); }}
            className="flex-1 bg-white border border-rose-300 text-rose-600 text-xs font-semibold px-3 py-2 rounded-lg">
            ปฏิเสธ
          </button>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg p-2.5 space-y-2">
          <p className="text-xs text-slate-700">
            {step === "confirm_accept" ? "ยืนยันตอบรับข้อเสนองานนี้?" : "ยืนยันปฏิเสธข้อเสนองานนี้?"}
          </p>
          <div className="flex gap-2">
            <button type="button" disabled={busy}
              onClick={() => respond(step === "confirm_accept" ? "accept" : "reject")}
              className={`flex-1 text-white text-xs font-bold px-3 py-2 rounded-lg disabled:opacity-50 ${
                step === "confirm_accept" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-rose-600 hover:bg-rose-700"
              }`}>
              {busy ? "กำลังบันทึก…" : step === "confirm_accept" ? "ยืนยันตอบรับ" : "ยืนยันปฏิเสธ"}
            </button>
            <button type="button" disabled={busy} onClick={() => setStep("view")}
              className="flex-1 bg-white border border-slate-300 text-slate-700 text-xs font-semibold px-3 py-2 rounded-lg">
              กลับ
            </button>
          </div>
        </div>
      )}
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

// Interview slot picker — groups bookable slots by date. Open slots are
// tappable; booked ones render greyed-out as "ไม่ว่าง" so the applicant
// can see (but not pick) times others already took.
function SlotPicker({
  slots, onPick
}: {
  slots: BookableSlot[];
  onPick: (slot: BookableSlot) => void;
}) {
  // Preserve the server's date order while grouping.
  const groups: Array<[string, BookableSlot[]]> = [];
  const idx = new Map<string, BookableSlot[]>();
  for (const s of slots) {
    let arr = idx.get(s.slot_date);
    if (!arr) { arr = []; idx.set(s.slot_date, arr); groups.push([s.slot_date, arr]); }
    arr.push(s);
  }
  // Surface the venue once per day (open slots usually share one location).
  const dayLocation = (daySlots: BookableSlot[]): string | null =>
    daySlots.find((s) => s.status === "open" && s.location)?.location ?? null;

  return (
    <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
      <p className="text-[11px] text-slate-500">แตะเลือกช่วงเวลา แล้วกดยืนยันอีกครั้ง</p>
      {groups.map(([date, daySlots]) => {
        const loc = dayLocation(daySlots);
        return (
          <div key={date}>
            <div className="text-[11px] font-bold text-slate-600 mb-1">
              {weekdayTh(date)} · {formatLongDate(date, "th")}
              {loc && <span className="ml-1 font-normal text-slate-400">· {loc}</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {daySlots.map((s) => {
                const taken = s.status !== "open";
                return (
                  <button key={s.id} type="button"
                    disabled={taken}
                    onClick={() => onPick(s)}
                    className={`text-[11px] px-2 py-1 rounded-lg border font-mono tabular-nums ${
                      taken
                        ? "border-slate-200 bg-slate-100 text-slate-400 line-through cursor-not-allowed"
                        : "border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                    }`}>
                    {s.start_time}–{s.end_time}{taken ? " · ไม่ว่าง" : ""}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
