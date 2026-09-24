"use client";

import { useState } from "react";

// Customer feedback funnel — a single, short flow:
//   step "form" → tap 1-5 stars (required) + an optional note. One
//                 decision to make, then done (owner 2026-09-23:
//                 "ลูกค้าจะได้คิดครั้งเดียว").
//   step "done" → routing screen. The Google "write a review" link is
//                 the hero and comes FIRST (owner wants to drive real
//                 reviews); the completion reward is shown AFTER it as a
//                 thank-you. The link shows for EVERY score (no gating);
//                 the copy just leans celebratory on a high tier and
//                 apologetic on a low one. The reward is for finishing
//                 the survey — never conditioned on a positive score or
//                 on actually leaving a Google review (Google prohibits
//                 incentivised reviews, and a review can't be verified
//                 anyway).

type SubmitResult = {
  token: string;
  rating: number;
  tier: "high" | "low";
  google_review_url: string | null;
  reward_code: string | null;
  reward_text: string | null;
  reward_qr: string | null;
};

function Stars({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex justify-center gap-1.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`${n} ดาว`}
          onClick={() => onChange(n)}
          className={`text-4xl leading-none transition-transform active:scale-90 ${
            n <= value ? "text-amber-400" : "text-slate-200"
          }`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

export default function FeedbackClient({ branchSlug, branchName, inviteToken }: {
  branchSlug: string; branchName: string; inviteToken?: string | null;
}) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [wentToGoogle, setWentToGoogle] = useState(false);

  async function submit() {
    if (rating < 1 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/insigna/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch_slug: branchSlug,
          rating,
          comment: comment.trim() || null,
          t: inviteToken ?? null
        })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "submit_failed");
      setResult(data as SubmitResult);
    } catch (e) {
      setError(
        e instanceof Error && e.message === "too_many_requests"
          ? "ส่งบ่อยเกินไป รอสักครู่แล้วลองใหม่นะคะ"
          : "ส่งไม่สำเร็จ ลองอีกครั้งนะคะ"
      );
    } finally {
      setBusy(false);
    }
  }

  function openGoogle() {
    if (!result?.google_review_url) return;
    setWentToGoogle(true);
    // fire-and-forget click beacon, then hop to Google
    void fetch("/api/insigna/reviews/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: result.token, event: "google_click" }),
      keepalive: true
    }).catch(() => {});
    window.open(result.google_review_url, "_blank", "noopener,noreferrer");
  }

  async function copyComment() {
    if (!comment.trim()) return;
    try {
      await navigator.clipboard.writeText(comment.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — the customer can still type */ }
  }

  const Header = (
    <div className="rounded-t-2xl bg-ink-gradient text-white px-5 py-4">
      <div className="flex items-baseline justify-between text-[11px] tracking-wider">
        <span className="text-brand-light font-bold">IKIGAI</span>
        <span className="text-slate-300">รีวิวร้าน</span>
      </div>
      <h1 className="text-lg font-bold mt-1">{branchName}</h1>
    </div>
  );

  // ── DONE — routing screen (Google first, reward after) ─────────
  if (result) {
    const high = result.tier === "high";
    return (
      <div className="mt-6">
        {Header}
        <div className="bg-white rounded-b-2xl shadow border border-slate-200 p-5 space-y-4">
          <div className="text-center pt-1">
            <div className="text-lg font-bold text-slate-800">
              {high ? "ขอบคุณมากค่ะ" : "ขอบคุณสำหรับความเห็นตรงๆ ค่ะ"}
            </div>
            <p className="text-sm text-slate-500 mt-1">
              {high
                ? "ดีใจที่คุณประทับใจ ถ้าสะดวก รบกวนช่วยรีวิวให้ร้านหน่อยนะคะ"
                : "เรารับไว้และจะรีบปรับปรุงทันที ทีมงานดูแลเรื่องนี้ให้ค่ะ"}
            </p>
          </div>

          {/* Google review — the hero, shown FIRST, for every score (no gating) */}
          {result.google_review_url && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={openGoogle}
                className={`w-full rounded-xl py-3.5 font-bold text-white transition active:scale-[0.99] ${
                  high ? "bg-brand hover:opacity-95" : "bg-slate-500 hover:opacity-95"
                }`}
              >
                เขียนรีวิวบน Google
              </button>
              {comment.trim() && (
                <button
                  type="button"
                  onClick={copyComment}
                  className="w-full rounded-xl py-2.5 text-sm font-semibold text-slate-600 border border-slate-200 bg-slate-50 hover:bg-slate-100"
                >
                  {copied ? "คัดลอกแล้ว วางใน Google ได้เลย" : "คัดลอกข้อความของคุณ ไปวางใน Google"}
                </button>
              )}
              <p className="text-[11px] text-slate-400 text-center">
                รีวิว Google เปิดในหน้าใหม่ · จะรีวิวหรือไม่ก็ได้ ไม่มีผลกับสิทธิ์ด้านล่างค่ะ
              </p>
            </div>
          )}

          {/* Reward — AFTER the Google ask, for COMPLETING the survey (everyone) */}
          {result.reward_code && result.reward_text && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-center">
              <div className="text-[11px] font-bold uppercase tracking-wide text-amber-600">
                สิทธิ์รอบหน้าของคุณ
              </div>
              <div className="text-sm text-amber-800 mt-1">{result.reward_text}</div>
              {result.reward_qr && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={result.reward_qr} alt="QR รางวัล" width={150} height={150}
                  className="mx-auto mt-3 w-[150px] h-[150px] rounded-lg bg-white p-1.5 shadow-sm" />
              )}
              <div className="mt-2 text-2xl font-black tracking-widest text-amber-700 tabular-nums">
                {result.reward_code}
              </div>
              <div className="text-[11px] text-amber-600 mt-1">ให้พนักงานสแกน QR หรือกรอกโค้ดนี้</div>
              <div className="text-[11px] text-amber-500 mt-1">
                {wentToGoogle
                  ? "ขอบคุณที่ช่วยรีวิวค่ะ แสดงโค้ดนี้กับพนักงานในครั้งถัดไปที่มาใช้บริการ (ใช้ในวันนี้ไม่ได้ค่ะ)"
                  : "แสดงโค้ดนี้กับพนักงานในครั้งถัดไปที่มาใช้บริการค่ะ (ใช้ในวันนี้ไม่ได้)"}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── FORM — one decision: overall stars, + an optional note ─────
  return (
    <div className="mt-6">
      {Header}
      <div className="bg-white rounded-b-2xl shadow border border-slate-200 p-5 space-y-5">
        <div className="text-center">
          <div className="text-slate-700 font-semibold">วันนี้เป็นยังไงบ้างคะ?</div>
          <p className="text-xs text-slate-400 mt-0.5">แตะดาวให้คะแนนความพอใจโดยรวม</p>
        </div>

        <Stars value={rating} onChange={setRating} />

        {/* Optional note — revealed once they've given a score */}
        {rating > 0 && (
          <div className="border-t border-slate-100 pt-4">
            <div className="text-sm text-slate-600 mb-1.5">
              อยากบอกอะไรเราไหมคะ? <span className="text-slate-300">(ไม่บังคับ)</span>
            </div>
            <textarea
              className="input"
              rows={3}
              value={comment}
              maxLength={1000}
              onChange={(e) => setComment(e.target.value)}
              placeholder="เล่าให้เราฟังได้เลยค่ะ ทั้งที่ชอบและที่อยากให้ปรับ"
            />
          </div>
        )}

        {error && <div className="text-sm text-rose-600 text-center">{error}</div>}

        <button
          type="button"
          disabled={rating < 1 || busy}
          onClick={submit}
          className="w-full rounded-xl bg-brand py-3 font-bold text-white disabled:opacity-40 transition active:scale-[0.99]"
        >
          {busy ? "กำลังส่ง…" : "ส่งความเห็น"}
        </button>
        <p className="text-[11px] text-slate-400 text-center">
          เราไม่เก็บชื่อหรือเบอร์ของคุณ · ความเห็นนี้ช่วยให้ร้านดีขึ้นค่ะ
        </p>
      </div>
    </div>
  );
}
