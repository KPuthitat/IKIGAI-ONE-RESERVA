"use client";

import { useState } from "react";

// Customer feedback funnel — a single self-contained flow:
//   step "form" → tap 1-5 stars (+ optional axes / return intent / note)
//   step "done" → routing screen. The Google link shows for EVERY score
//                 (no gating); the copy leans celebratory on a high tier
//                 and apologetic on a low one. The reward is for finishing
//                 the survey, shown to everyone with a code.

type SubmitResult = {
  token: string;
  rating: number;
  tier: "high" | "low";
  google_review_url: string | null;
  reward_code: string | null;
  reward_text: string | null;
};

const AXES: Array<{ key: "food_rating" | "service_rating" | "ambience_rating"; icon: string; label: string }> = [
  { key: "food_rating", icon: "🍽️", label: "อาหาร" },
  { key: "service_rating", icon: "🙋", label: "บริการ" },
  { key: "ambience_rating", icon: "✨", label: "บรรยากาศ / ความสะอาด" }
];

function Stars({ value, onChange, size = "text-4xl" }: {
  value: number; onChange: (v: number) => void; size?: string;
}) {
  return (
    <div className="flex justify-center gap-1.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`${n} ดาว`}
          onClick={() => onChange(n)}
          className={`${size} leading-none transition-transform active:scale-90 ${
            n <= value ? "text-amber-400" : "text-slate-200"
          }`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

export default function FeedbackClient({ branchSlug, branchName }: {
  branchSlug: string; branchName: string;
}) {
  const [rating, setRating] = useState(0);
  const [axes, setAxes] = useState<Record<string, number>>({});
  const [returnIntent, setReturnIntent] = useState<boolean | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [copied, setCopied] = useState(false);

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
          food_rating: axes.food_rating ?? null,
          service_rating: axes.service_rating ?? null,
          ambience_rating: axes.ambience_rating ?? null,
          return_intent: returnIntent,
          comment: comment.trim() || null
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

  // ── DONE — routing screen ──────────────────────────────────────
  if (result) {
    const high = result.tier === "high";
    return (
      <div className="mt-6">
        {Header}
        <div className="bg-white rounded-b-2xl shadow border border-slate-200 p-5 space-y-4">
          <div className="text-center pt-2">
            <div className="text-5xl mb-2">{high ? "🌟" : "🙏"}</div>
            <div className="text-lg font-bold text-slate-800">
              {high ? "ขอบคุณมากๆ ค่ะ!" : "ขอบคุณสำหรับความเห็นตรงๆ ค่ะ"}
            </div>
            <p className="text-sm text-slate-500 mt-1">
              {high
                ? "ดีใจที่คุณประทับใจ 💛 ถ้าสะดวก รบกวนช่วยรีวิวให้ร้านหน่อยนะคะ"
                : "เรารับไว้และจะรีบปรับปรุงทันที ทีมงานดูแลเรื่องนี้ให้ค่ะ"}
            </p>
          </div>

          {/* Reward — for COMPLETING the survey, shown to everyone */}
          {result.reward_code && result.reward_text && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-center">
              <div className="text-[11px] font-bold uppercase tracking-wide text-amber-600">
                🎁 สิทธิ์รอบหน้าของคุณ
              </div>
              <div className="text-sm text-amber-800 mt-1">{result.reward_text}</div>
              <div className="mt-2 text-2xl font-black tracking-widest text-amber-700 tabular-nums">
                {result.reward_code}
              </div>
              <div className="text-[11px] text-amber-500 mt-1">
                แสดงโค้ดนี้กับพนักงานในครั้งถัดไปค่ะ
              </div>
            </div>
          )}

          {/* Google review — shown for EVERY score (no gating) */}
          {result.google_review_url && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={openGoogle}
                className={`w-full rounded-xl py-3 font-bold text-white transition active:scale-[0.99] ${
                  high ? "bg-brand hover:opacity-95" : "bg-slate-500 hover:opacity-95"
                }`}
              >
                ⭐ เขียนรีวิวบน Google
              </button>
              {comment.trim() && (
                <button
                  type="button"
                  onClick={copyComment}
                  className="w-full rounded-xl py-2.5 text-sm font-semibold text-slate-600 border border-slate-200 bg-slate-50 hover:bg-slate-100"
                >
                  {copied ? "✓ คัดลอกแล้ว วางใน Google ได้เลย" : "📋 คัดลอกข้อความของคุณ ไปวางใน Google"}
                </button>
              )}
              <p className="text-[11px] text-slate-400 text-center">
                รีวิว Google เปิดในหน้าใหม่ · จะรีวิวหรือไม่ก็ได้ ไม่มีผลกับสิทธิ์ด้านบนค่ะ
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── FORM ───────────────────────────────────────────────────────
  return (
    <div className="mt-6">
      {Header}
      <div className="bg-white rounded-b-2xl shadow border border-slate-200 p-5 space-y-5">
        <div className="text-center">
          <div className="text-slate-700 font-semibold">วันนี้เป็นยังไงบ้างคะ?</div>
          <p className="text-xs text-slate-400 mt-0.5">แตะดาวให้คะแนนความพอใจโดยรวม</p>
        </div>

        <Stars value={rating} onChange={setRating} />

        {/* Optional detail — revealed once they've given an overall score */}
        {rating > 0 && (
          <div className="space-y-4 border-t border-slate-100 pt-4">
            {AXES.map((a) => (
              <div key={a.key}>
                <div className="text-sm text-slate-600 mb-1">
                  {a.icon} {a.label} <span className="text-slate-300">(ไม่บังคับ)</span>
                </div>
                <Stars
                  value={axes[a.key] ?? 0}
                  onChange={(v) => setAxes((s) => ({ ...s, [a.key]: v }))}
                  size="text-2xl"
                />
              </div>
            ))}

            <div>
              <div className="text-sm text-slate-600 mb-1.5">
                🔁 จะกลับมาอีกไหมคะ? <span className="text-slate-300">(ไม่บังคับ)</span>
              </div>
              <div className="flex gap-2">
                {[
                  { v: true, label: "กลับมาแน่นอน" },
                  { v: false, label: "ยังไม่แน่ใจ" }
                ].map((o) => (
                  <button
                    key={String(o.v)}
                    type="button"
                    onClick={() => setReturnIntent((cur) => (cur === o.v ? null : o.v))}
                    className={`flex-1 rounded-lg py-2 text-sm font-medium border transition ${
                      returnIntent === o.v
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-slate-200 bg-slate-50 text-slate-500"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-sm text-slate-600 mb-1.5">
                💬 อยากบอกอะไรเราไหมคะ? <span className="text-slate-300">(ไม่บังคับ)</span>
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
          เราไม่เก็บชื่อหรือเบอร์ของคุณ · ความเห็นนี้ช่วยให้ร้านดีขึ้นค่ะ 🙏
        </p>
      </div>
    </div>
  );
}
