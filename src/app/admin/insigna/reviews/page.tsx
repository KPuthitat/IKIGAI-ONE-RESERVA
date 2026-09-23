// /admin/insigna/reviews — review-funnel back office (owner 2026-09-23).
//
// Summary of the customer feedback → Google review flow, the
// service-recovery queue (low-tier reviews land here, never on Google),
// per-branch Google link config, reward-code redemption, and the enable
// toggle. Read data renders server-side; the mutating forms live in the
// client island.

import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { formatBkkDateTime } from "@/lib/time";
import {
  getReviewConfig,
  reviewSummary,
  listReviews,
  listBranchReviewInfo,
  type ReviewRow
} from "@/lib/insigna";
import { Icon } from "@/components/Icon";
import ReviewsAdminClient from "./ReviewsAdminClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "รีวิวลูกค้า · INSIGNA" };

export default function InsignaReviewsPage() {
  requireAdmin();

  const cfg = getReviewConfig();
  const branches = listBranchReviewInfo();
  const branchName = new Map(branches.map((b) => [b.branch_id, b.branch_name]));

  const all = reviewSummary({ days: null });
  const last30 = reviewSummary({ days: 30 });
  const recent = listReviews({ limit: 60 });
  const lowQueue = listReviews({ tier: "low", limit: 20 });

  const ctr = all.googleShown > 0 ? Math.round((all.googleClicked / all.googleShown) * 100) : null;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/insigna" className="text-xs text-slate-400 hover:text-brand">← INSIGNA</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-1">รีวิวลูกค้า · Review funnel</h1>
        <p className="text-sm text-slate-500 mt-1">
          ลูกค้าให้คะแนนในระบบเราก่อน → ชวนรีวิว Google ทุกคน (คำเชิญปรับตามคะแนน ไม่กรอง) ·
          ของแลกผูกกับการกรอกแบบประเมิน ไม่ผูกกับคะแนน/รีวิว
        </p>
      </div>

      {/* config + claim + branch links (client island) */}
      <ReviewsAdminClient
        initialEnabled={cfg.enabled}
        initialRewardText={cfg.reward_text ?? ""}
        initialThreshold={cfg.high_threshold}
        branches={branches.map((b) => ({
          id: b.branch_id, name: b.branch_name, slug: b.branch_slug, url: b.google_review_url ?? ""
        }))}
      />

      {/* summary counters */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "รีวิวทั้งหมด", v: String(all.total), sub: `30 วัน: ${last30.total}` },
          { label: "คะแนนเฉลี่ย", v: all.avg != null ? `${all.avg.toFixed(2)}★` : "—", sub: `30 วัน: ${last30.avg != null ? last30.avg.toFixed(2) + "★" : "—"}` },
          { label: "กดไป Google", v: ctr != null ? `${ctr}%` : "—", sub: `${all.googleClicked}/${all.googleShown} ครั้ง` },
          { label: "ของแลกใช้แล้ว", v: `${all.rewardsClaimed}/${all.rewardsIssued}`, sub: "ใช้/ออกโค้ด" }
        ].map((c) => (
          <div key={c.label} className="card">
            <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">{c.label}</div>
            <div className="text-2xl font-bold text-slate-800 mt-1 tabular-nums">{c.v}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* star distribution */}
      <div className="card">
        <h2 className="text-sm font-bold text-slate-700 mb-3">การกระจายคะแนน (ทั้งหมด)</h2>
        {all.total === 0 ? (
          <div className="text-xs text-slate-400 py-4 text-center">ยังไม่มีรีวิว</div>
        ) : (
          <div className="space-y-1.5">
            {([5, 4, 3, 2, 1] as const).map((star) => {
              const n = all.dist[star];
              const pct = all.total ? (n / all.total) * 100 : 0;
              return (
                <div key={star} className="flex items-center gap-2 text-xs">
                  <span className="w-8 text-amber-500 font-bold">{star}★</span>
                  <div className="flex-1 h-2.5 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${star >= cfg.high_threshold ? "bg-emerald-400" : "bg-amber-400"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-8 text-right font-mono text-slate-500">{n}</span>
                </div>
              );
            })}
            <div className="text-[11px] text-slate-400 pt-1">
              เขียว = ถึงเกณฑ์ชวนรีวิว Google (≥ {cfg.high_threshold}★) · เหลือง = เข้าคิวดูแลหลังบ้าน
            </div>
          </div>
        )}
      </div>

      {/* service-recovery queue */}
      <div className="card">
        <h2 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-1.5">
          <Icon name="alert" className="h-4 w-4 text-rose-600" />
          คิวดูแลหลังบ้าน — คะแนนต่ำ ({lowQueue.length})
        </h2>
        {lowQueue.length === 0 ? (
          <div className="text-xs text-slate-400 py-4 text-center">ไม่มีคะแนนต่ำค้างอยู่ 🎉</div>
        ) : (
          <div className="space-y-2">
            {lowQueue.map((r) => <ReviewCard key={r.token} r={r} branchName={branchName.get(r.branch_id ?? -1)} lowlight />)}
          </div>
        )}
      </div>

      {/* recent all */}
      <div className="card">
        <h2 className="text-sm font-bold text-slate-700 mb-3">รีวิวล่าสุด</h2>
        {recent.length === 0 ? (
          <div className="text-xs text-slate-400 py-4 text-center">ยังไม่มีรีวิว — เปิดฟีเจอร์แล้วแปะ QR ที่โต๊ะ / ส่งลิงก์ /f/&lt;slug&gt;</div>
        ) : (
          <div className="space-y-2">
            {recent.map((r) => <ReviewCard key={r.token} r={r} branchName={branchName.get(r.branch_id ?? -1)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewCard({ r, branchName, lowlight }: { r: ReviewRow; branchName?: string; lowlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 text-sm ${lowlight ? "border-rose-100 bg-rose-50/40" : "border-slate-100 bg-slate-50/60"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-amber-500 font-bold">{"★".repeat(r.rating)}<span className="text-slate-200">{"★".repeat(5 - r.rating)}</span></span>
        {branchName && <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{branchName}</span>}
        {r.clicked_google === 1 && <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">→ Google</span>}
        {r.reward_code && (
          <span className={`text-[11px] px-1.5 py-0.5 rounded font-mono ${r.reward_claimed ? "bg-slate-200 text-slate-400 line-through" : "bg-amber-100 text-amber-700"}`}>
            {r.reward_code}
          </span>
        )}
        <span className="text-[11px] text-slate-400 ml-auto">{formatBkkDateTime(r.created_at)}</span>
      </div>
      {(r.food_rating || r.service_rating || r.ambience_rating || r.return_intent != null) && (
        <div className="text-[11px] text-slate-500 mt-1 flex gap-3 flex-wrap">
          {r.food_rating != null && <span>🍽️ {r.food_rating}</span>}
          {r.service_rating != null && <span>🙋 {r.service_rating}</span>}
          {r.ambience_rating != null && <span>✨ {r.ambience_rating}</span>}
          {r.return_intent != null && <span>🔁 {r.return_intent ? "กลับมาแน่นอน" : "ยังไม่แน่ใจ"}</span>}
        </div>
      )}
      {r.comment && <div className="text-slate-700 mt-1.5 whitespace-pre-wrap">“{r.comment}”</div>}
    </div>
  );
}
