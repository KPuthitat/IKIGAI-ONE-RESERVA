// Public customer feedback page — /f/[branch-slug].
//
// The QR at the table / the link on the LINE thank-you card resolves
// here. NO login: this is customer-facing. The customer rates the
// visit, and the thank-you screen routes them to the branch's Google
// review (shown to everyone, wording adapts to the score) plus a
// reward for completing the survey. All the logic + storage is PII-free
// (see src/lib/insigna/reviews.ts).

import type { Metadata } from "next";
import { getReviewConfig, getBranchReviewInfo } from "@/lib/insigna";
import FeedbackClient from "./FeedbackClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "รีวิวร้าน · IKIGAI",
  robots: { index: false, follow: false }
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-100 flex items-start justify-center p-4">
      <div className="max-w-md w-full">{children}</div>
    </div>
  );
}

function safeDecode(raw: string): string {
  try { return decodeURIComponent(raw); } catch { return raw; }
}

export default function FeedbackPage({ params }: { params: { slug: string } }) {
  const cfg = getReviewConfig();
  const branch = getBranchReviewInfo(safeDecode(params.slug ?? ""));

  if (!cfg.enabled || !branch) {
    return (
      <Shell>
        <div className="bg-white rounded-2xl shadow border border-slate-200 p-8 text-center mt-10">
          <div className="text-4xl mb-3">🌿</div>
          <div className="text-slate-700 font-semibold">ยังไม่เปิดรับรีวิวตอนนี้</div>
          <div className="text-sm text-slate-400 mt-1">
            ขอบคุณที่แวะมานะคะ ไว้กลับมาใหม่ค่ะ 🙏
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <FeedbackClient branchSlug={branch.branch_slug} branchName={branch.branch_name} />
    </Shell>
  );
}
