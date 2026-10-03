// Public member card — /m?t=<link token>. Opened from the "บัตรสมาชิก" card in
// the customer's LINE chat. NO login: the token resolves server-side to the
// customer's LINE id → INSIGNA pseudonym. Shows the member code, the QR staff
// scan at checkout, the visit summary, rewards, and the PDPA controls
// (consent, delete). PII-free — no name anywhere.

import type { Metadata } from "next";
import Link from "next/link";
import QRCode from "qrcode";
import {
  resolveMemberLink, getMemberByHash, customerBillStats, countPendingBills, listCustomerRewards
} from "@/lib/insigna";
import { getDb } from "@/lib/db";
import { formatLongDate } from "@/lib/time";
import MemberActions from "./MemberActions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "บัตรสมาชิก · IKIGAI", robots: { index: false, follow: false } };

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/+$/, "");
const TH_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const money = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

export default async function MemberCardPage({ searchParams }: { searchParams: { t?: string } }) {
  const token = typeof searchParams?.t === "string" ? searchParams.t : null;
  if (!token) return <Empty title="เปิดจากลิงก์ใน LINE นะคะ" sub="พิมพ์คำว่า “สมาชิก” ในแชท LINE ของร้าน แล้วกดปุ่มในการ์ดค่ะ" />;
  const link = resolveMemberLink(token);
  if (!link) return <Empty title="ลิงก์นี้ใช้ไม่ได้แล้ว" sub="พิมพ์คำว่า “สมาชิก” ในแชท LINE ของร้านเพื่อรับลิงก์ใหม่ค่ะ" />;
  const member = getMemberByHash(link.customer_hash);
  if (!member?.member_code) {
    return (
      <Shell>
        <div className="bg-white rounded-2xl shadow border border-slate-200 p-8 text-center mt-10">
          <div className="text-4xl mb-3">🌿</div>
          <div className="text-slate-700 font-semibold">ยังไม่ได้เป็นสมาชิก</div>
          <div className="text-sm text-slate-400 mt-1">สมัครฟรีในไม่ถึงนาที เราเก็บเพียงวันเกิดและเพศ ไม่เก็บชื่อ</div>
          <Link href={`/m/join?t=${encodeURIComponent(token)}`} className="inline-block mt-5 px-5 py-2.5 rounded-xl bg-emerald-600 text-white font-bold text-sm">สมัครสมาชิก</Link>
        </div>
      </Shell>
    );
  }

  const branch = member.signup_branch_id
    ? (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(member.signup_branch_id) as { name: string } | undefined)
    : undefined;
  const stats = customerBillStats(link.customer_hash);
  const pending = countPendingBills(link.customer_hash);
  const rewards = listCustomerRewards(link.customer_hash).filter((r) => r.status === "usable" || r.status === "not_yet");
  const scanUrl = `${PUBLIC_BASE}/m/s/${member.scan_token ?? ""}`;
  const qr = member.scan_token ? await QRCode.toDataURL(scanUrl, { width: 480, margin: 1, errorCorrectionLevel: "M" }) : null;
  const birthday = member.birth_day && member.birth_month
    ? `${member.birth_day} ${TH_MONTHS[member.birth_month]}${member.birth_year ? ` พ.ศ. ${member.birth_year + 543}` : ""}`
    : null;
  const genderTh = member.gender === "F" ? "หญิง" : member.gender === "M" ? "ชาย" : member.gender === "X" ? "ไม่ระบุ" : null;

  return (
    <Shell>
      <div className="mt-6 space-y-4">
        <div className="text-center">
          <div className="text-[11px] font-bold uppercase tracking-widest text-brand">IKIGAI</div>
          <h1 className="text-xl font-bold text-slate-800 mt-1">บัตรสมาชิก</h1>
          {branch?.name && <p className="text-xs text-slate-400 mt-1">สมัครที่ {branch.name}</p>}
        </div>

        <div className="bg-white rounded-2xl shadow border border-emerald-200 p-5 text-center">
          <div className="text-[11px] text-slate-500">หมายเลขสมาชิก</div>
          <div className="mt-1 text-4xl font-black tracking-[0.2em] text-emerald-800 tabular-nums">{member.member_code}</div>
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="QR สมาชิก" width={200} height={200} className="mx-auto my-4 w-[200px] h-[200px] rounded-lg" />
          )}
          <div className="text-[11px] text-emerald-700">ให้พนักงานสแกนตอนชำระเงิน เพื่อบันทึกการมาใช้บริการครั้งนี้</div>
          {member.member_since && <div className="text-[11px] text-slate-400 mt-1">สมาชิกตั้งแต่ {formatLongDate(member.member_since.slice(0, 10), "th")}</div>}
        </div>

        <div className="bg-white rounded-2xl shadow border border-slate-200 p-4">
          <div className="text-xs font-semibold text-slate-500 mb-2">ประวัติการมาใช้บริการ</div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-slate-50 p-2">
              <div className="text-lg font-bold text-slate-800 tabular-nums">{stats.distinctDays}</div>
              <div className="text-[10px] text-slate-500">ครั้งที่มา</div>
            </div>
            <div className="rounded-xl bg-slate-50 p-2">
              <div className="text-lg font-bold text-slate-800 tabular-nums">{stats.totalNett > 0 ? money(stats.totalNett) : "—"}</div>
              <div className="text-[10px] text-slate-500">ยอดสะสม (บาท)</div>
            </div>
            <div className="rounded-xl bg-slate-50 p-2">
              <div className="text-sm font-bold text-slate-800 leading-tight">{stats.lastVisit ? formatLongDate(stats.lastVisit, "th") : "—"}</div>
              <div className="text-[10px] text-slate-500">มาล่าสุด</div>
            </div>
          </div>
          {pending > 0 && <div className="text-[11px] text-amber-700 mt-2">บิลที่รอบันทึก {pending} ใบ (ระบบจะนับให้หลังปิดยอดประจำวัน)</div>}
          {stats.topItems.length > 0 && (
            <div className="text-[11px] text-slate-500 mt-2">เมนูที่สั่งบ่อย: {stats.topItems.slice(0, 3).map((i) => i.name).join(", ")}</div>
          )}
        </div>

        {rewards.length > 0 && (
          <div className="bg-white rounded-2xl shadow border border-amber-200 p-4">
            <div className="text-xs font-semibold text-amber-800 mb-2">สิทธิ์ของฉัน</div>
            {rewards.map((r) => (
              <div key={r.code} className="flex items-center justify-between gap-2 py-1.5 border-b border-amber-50 last:border-b-0">
                <div>
                  <div className="font-mono font-bold text-amber-800">{r.code}</div>
                  {r.reward_text && <div className="text-[11px] text-slate-500">{r.reward_text}{r.branch_name ? ` · ${r.branch_name}` : ""}</div>}
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${r.status === "usable" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                  {r.status === "usable" ? "พร้อมใช้" : "ใช้ได้ครั้งถัดไป"}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="bg-white rounded-2xl shadow border border-slate-200 p-4">
          <div className="text-xs font-semibold text-slate-500 mb-2">ข้อมูลของฉัน</div>
          <div className="text-sm text-slate-700 space-y-0.5">
            <div>วันเกิด: {birthday ?? "—"}</div>
            <div>เพศ: {genderTh ?? "—"}</div>
            <div>ย่านที่พักอาศัย: {member.home_area ?? "—"}</div>
          </div>
          <Link href={`/m/join?t=${encodeURIComponent(token)}`} className="inline-block mt-3 text-sm text-brand underline">แก้ไขข้อมูล</Link>
          <MemberActions token={token} consentMarketing={member.consent_marketing === 1} />
        </div>

        <p className="text-center text-[11px] text-slate-400 pt-2">เราไม่เก็บชื่อของท่าน พนักงานเห็นเพียงหมายเลขสมาชิกเท่านั้น</p>
      </div>
    </Shell>
  );
}
