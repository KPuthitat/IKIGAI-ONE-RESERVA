// Public membership sign-up — /m/join?t=<link token>. The token came from the
// "สมัครสมาชิก" card the branch OA pushed, so the LINE userId is already
// known server-side; the form only asks for what we keep (birthday, gender,
// home area, how they found us, consent). Re-opened by a member to edit.

import type { Metadata } from "next";
import { resolveMemberLink, getMemberByHash } from "@/lib/insigna";
import { getDb } from "@/lib/db";
import JoinClient from "./JoinClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สมัครสมาชิก · IKIGAI", robots: { index: false, follow: false } };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-100 flex items-start justify-center p-4">
      <div className="max-w-md w-full">{children}</div>
    </div>
  );
}

export default function JoinPage({ searchParams }: { searchParams: { t?: string } }) {
  const token = typeof searchParams?.t === "string" ? searchParams.t : null;
  const link = token ? resolveMemberLink(token) : null;
  if (!token || !link) {
    return (
      <Shell>
        <div className="bg-white rounded-2xl shadow border border-slate-200 p-8 text-center mt-10">
          <div className="text-4xl mb-3">🌿</div>
          <div className="text-slate-700 font-semibold">เปิดจากลิงก์ใน LINE นะคะ</div>
          <div className="text-sm text-slate-400 mt-1">พิมพ์คำว่า “สมาชิก” ในแชท LINE ของร้าน แล้วกดปุ่ม “สมัครสมาชิก” ค่ะ</div>
        </div>
      </Shell>
    );
  }
  const branch = link.branch_id
    ? (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(link.branch_id) as { name: string } | undefined)
    : undefined;
  const existing = getMemberByHash(link.customer_hash);
  return (
    <Shell>
      <JoinClient
        token={token}
        branchName={branch?.name ?? "IKIGAI"}
        initial={existing?.member_code ? {
          member_code: existing.member_code,
          birth_day: existing.birth_day, birth_month: existing.birth_month, birth_year: existing.birth_year,
          gender: existing.gender, home_area: existing.home_area, acquisition_source: existing.acquisition_source,
          consent_marketing: existing.consent_marketing === 1
        } : null}
      />
    </Shell>
  );
}
