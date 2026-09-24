// Public "สิทธิ์ของฉัน" page — /rewards?t=<invite-token>.
//
// Opened from a per-customer button in the LINE OA (the reward card / review
// invite carries the token). NO login: the token resolves server-side to the
// customer's LINE id → INSIGNA pseudonym, and we list that pseudonym's reward
// codes with a status that mirrors the claim rules. PII-free — the page never
// sees a name/phone, only the hash's reward rows.

import type { Metadata } from "next";
import {
  resolveReviewInvite,
  hashLineUserId,
  listCustomerRewards,
  type CustomerReward
} from "@/lib/insigna";
import { formatLongDate, bkkDateIso } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "สิทธิ์ของฉัน · IKIGAI",
  robots: { index: false, follow: false }
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-100 flex items-start justify-center p-4">
      <div className="max-w-md w-full">{children}</div>
    </div>
  );
}

function Empty({ title, sub }: { title: string; sub: string }) {
  return (
    <Shell>
      <div className="bg-white rounded-2xl shadow border border-slate-200 p-8 text-center mt-10">
        <div className="text-4xl mb-3">🌿</div>
        <div className="text-slate-700 font-semibold">{title}</div>
        <div className="text-sm text-slate-400 mt-1">{sub}</div>
      </div>
    </Shell>
  );
}

const BADGE: Record<CustomerReward["status"], { label: string; cls: string }> = {
  usable:     { label: "พร้อมใช้",       cls: "bg-emerald-100 text-emerald-700" },
  not_yet:    { label: "ใช้ได้ครั้งถัดไป", cls: "bg-amber-100 text-amber-700" },
  claimed:    { label: "ใช้แล้ว",         cls: "bg-slate-200 text-slate-500" },
  superseded: { label: "ใช้สิทธิ์แล้ว",    cls: "bg-slate-200 text-slate-500" }
};

export default function MyRewardsPage({ searchParams }: { searchParams: { t?: string } }) {
  const token = typeof searchParams?.t === "string" ? searchParams.t : null;
  if (!token) {
    return <Empty title="เปิดจากลิงก์ใน LINE นะคะ" sub="กดปุ่ม “สิทธิ์ของฉัน” จากการ์ดในแชท LINE ของร้านค่ะ" />;
  }

  let rewards: CustomerReward[];
  try {
    // resolveReviewInvite returns null (and deletes the row) for an expired or
    // unknown token — that's a stale link, not an empty account.
    const invite = resolveReviewInvite(token);
    if (!invite) {
      return <Empty title="ลิงก์หมดอายุแล้ว" sub="รบกวนสแกน QR ที่โต๊ะทำแบบประเมินใหม่อีกครั้งนะคะ 🙏" />;
    }
    rewards = listCustomerRewards(hashLineUserId(invite.line_user_id));
  } catch {
    return <Empty title="ระบบขัดข้องชั่วคราว" sub="รบกวนลองใหม่อีกครั้งนะคะ 🙏" />;
  }

  if (rewards.length === 0) {
    return <Empty title="ยังไม่มีสิทธิ์ในระบบ" sub="ทำแบบประเมินหลังใช้บริการ แล้วโค้ดแลกส่วนลดจะมาอยู่ที่นี่ค่ะ" />;
  }

  const active = rewards.filter((r) => r.status === "usable" || r.status === "not_yet");
  const past = rewards.filter((r) => r.status === "claimed" || r.status === "superseded");

  return (
    <Shell>
      <div className="mt-6 space-y-4">
        <div className="text-center">
          <div className="text-[11px] font-bold uppercase tracking-widest text-brand">IKIGAI</div>
          <h1 className="text-xl font-bold text-slate-800 mt-1">สิทธิ์ของฉัน</h1>
          <p className="text-xs text-slate-400 mt-1">โค้ดแลกส่วนลดจากการรีวิว · แสดงให้พนักงานสแกนตอนมาใช้บริการ</p>
        </div>

        {active.map((r) => (
          <div key={r.code} className="bg-white rounded-2xl shadow border border-amber-200 p-5 text-center">
            <div className="flex items-center justify-center gap-2">
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${BADGE[r.status].cls}`}>{BADGE[r.status].label}</span>
              {r.branch_name && <span className="text-xs text-slate-400">{r.branch_name}</span>}
            </div>
            {r.reward_text && <div className="text-sm text-amber-800 mt-2">{r.reward_text}</div>}
            <div className="mt-2 text-3xl font-black tracking-widest text-amber-700 tabular-nums">{r.code}</div>
            <div className="text-[11px] text-amber-600 mt-1">ให้พนักงานสแกน/พิมพ์โค้ดนี้</div>
            <div className="text-[11px] text-slate-400 mt-1">
              {r.status === "not_yet"
                ? "ใช้ในวันที่ทำแบบประเมินไม่ได้ · ใช้ได้ครั้งถัดไปที่มาใช้บริการ"
                : "ใช้ได้ครั้งถัดไปที่มาใช้บริการ · 1 สิทธิ์ต่อสาขา"}
            </div>
          </div>
        ))}

        {past.length > 0 && (
          <div className="bg-white rounded-2xl shadow border border-slate-200 p-4">
            <div className="text-xs font-semibold text-slate-500 mb-2">ประวัติสิทธิ์</div>
            <div className="space-y-1.5">
              {past.map((r) => (
                <div key={r.code} className="flex items-center gap-2 text-xs py-1 border-b border-slate-50 last:border-b-0">
                  <span className="font-mono text-slate-400 line-through">{r.code}</span>
                  {r.branch_name && <span className="text-slate-400">· {r.branch_name}</span>}
                  <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full ${BADGE[r.status].cls}`}>{BADGE[r.status].label}</span>
                  <span className="text-slate-300">
                    {r.status === "claimed" && r.claimed_at ? formatLongDate(bkkDateIso(r.claimed_at), "th") : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-center text-[11px] text-slate-400 pt-2">ขอบคุณที่ให้ความเห็นกับเรานะคะ 🙏</p>
      </div>
    </Shell>
  );
}
