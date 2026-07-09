import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { isRevshareBranch } from "@/lib/revshare-db";
import { materialPurchaseQuota, ledgerDashboard } from "@/lib/accounta-db";
import { fmtMoney } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · IKIGAI OS" };

// ACCOUNTA landing (owner 2026-06-20): two top-level areas only —
// บัญชีรายรับรายจ่าย (the income/expense ledger hub) + แฟ้มวิเคราะห์โครงการลงทุน
// (FEASIBILITY). English name shown in EN mode.
export default function AccountaHome() {
  const user = requirePermission("accounta.manage");
  const lang = getLang();
  const en = lang === "en";
  // Revenue-Share (GP) appears only for branches that run a revenue-share
  // partner (revshare_enabled — currently HYPOPLARAEMIA).
  const showRevshare = user.activeBranchId != null && isRevshareBranch(user.activeBranchId);
  // Material-purchase quota for today — shown here too so it's easy to find
  // (owner 2026-07-05 "หาไม่เจอ"). Null when the branch has the feature off.
  const bkkToday = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const materialQuota = user.activeBranchId != null
    ? materialPurchaseQuota(user.activeBranchId, bkkToday, ledgerDashboard(user.activeBranchId, "month", bkkToday).forecast)
    : null;

  const cards = [
    {
      href: "/admin/accounta/daybook",
      title: en ? "Income and Expense Account" : "บัญชีรายรับรายจ่าย",
      sub: en
        ? "Record income & expenses, input/output VAT — add income or expense, then view the ledger"
        : "ลงรายรับ-รายจ่าย ภาษีซื้อ-ขาย — เพิ่มรายรับ เพิ่มรายจ่าย แล้วดูบัญชีรายรับรายจ่าย"
    },
    {
      href: "/admin/accounta/inbox",
      title: en ? "Documents to post" : "เอกสารรอลงบัญชี",
      sub: en
        ? "Bills scanned via the LINE OA, grouped by branch — review and post into the ledger"
        : "บิล/ใบเสร็จที่สแกนผ่านน้องฮูก รวมไว้ที่เดียว แยกตามสาขา — ตรวจแล้วยืนยันลงบัญชี"
    },
    {
      href: "/admin/accounta/vendors",
      title: en ? "Vendors / suppliers" : "ผู้จำหน่าย / คู่ค้า",
      sub: en
        ? "Manage the branch's vendor list — name, tax id, default category (shared with INVENTA)"
        : "จัดการรายชื่อคู่ค้าของสาขา — ชื่อ เลขผู้เสียภาษี หมวดเริ่มต้น (ใช้ร่วมกับ INVENTA)"
    },
    {
      href: "/admin/accounta/feasibility",
      title: en ? "Financial Feasibility Study" : "แฟ้มวิเคราะห์โครงการลงทุน",
      sub: en
        ? "Investment project feasibility + initial capital ledger and payback point"
        : "ประเมินความเป็นไปได้ของโปรเจคลงทุน + บัญชีเงินลงทุนตั้งต้น และจุดคืนทุน"
    },
    ...(showRevshare ? [{
      href: "/admin/accounta/revshare",
      title: en ? "Revenue-Share (GP)" : "ส่วนแบ่งยอดขาย (GP)",
      sub: en
        ? "Partner sales revenue split by progressive GP tiers — POS import + monthly billing statement"
        : "คำนวณส่วนแบ่งยอดขายจากคู่ค้า (แบ่งขั้นบันได) + นำเข้า POS + ออกใบวางบิลรายเดือน"
    }] : []),
    ...(user.role === "super_admin" ? [{
      href: "/admin/accounta/access",
      title: en ? "Branch access" : "สิทธิ์เข้าถึงตามสาขา",
      sub: en
        ? "Grant each person view / post access to specific branches' accounting"
        : "กำหนดสิทธิ์แต่ละคนว่าเข้าถึง (ดู/ยืนยันลงบัญชี) ของสาขาไหนได้บ้าง"
    }] : [])
  ];

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin" className="text-sm text-slate-500 hover:text-brand">
          {en ? "← Back to modules" : "← กลับหน้ารวมโมดูล"}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ACCOUNTA</h1>
        <p className="text-sm text-slate-500 mt-1">
          {en
            ? "Accounting — income/expense, input/output VAT, and per-branch investment feasibility"
            : "ระบบบัญชี — รายรับ-รายจ่าย ภาษีซื้อ-ขาย และประเมินความเป็นไปได้ของการลงทุนแต่ละสาขา"}
        </p>
      </div>

      {materialQuota && (
        <Link href="/admin/accounta/daybook" className="card block hover:shadow-lg transition">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="font-bold text-slate-800">โควตาสั่งซื้อวัตถุดิบวันนี้</h2>
            <span className="text-[11px] text-brand font-medium">เปิดบัญชีรายรับรายจ่าย →</span>
          </div>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-2">
              <div className="text-[11px] text-slate-500">โควตาวันนี้{materialQuota.todayIsPurchaseDay ? ` · วัน${materialQuota.weekdayLabel}` : ""}</div>
              <div className="text-xl font-bold text-emerald-700">฿{fmtMoney(materialQuota.quotaToday)}</div>
            </div>
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-2">
              <div className="text-[11px] text-slate-500">งบเดือนนี้</div>
              <div className="text-lg font-bold text-slate-700">฿{fmtMoney(materialQuota.monthBudget)}</div>
            </div>
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-2">
              <div className="text-[11px] text-slate-500">ซื้อวัตถุดิบไปแล้ว</div>
              <div className="text-lg font-bold text-rose-600">฿{fmtMoney(materialQuota.spentThisMonth)}</div>
            </div>
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-2">
              <div className="text-[11px] text-slate-500">เหลือทั้งเดือน</div>
              <div className="text-lg font-bold text-slate-800">฿{fmtMoney(materialQuota.remainingBudget)}</div>
            </div>
          </div>
        </Link>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {cards.map((c) => (
          <Link key={c.href} href={c.href}
            className="card hover:shadow-lg transition group block space-y-1">
            <div className="text-[11px] tracking-[1px] text-slate-400">{en ? "AREA" : "ส่วนงาน"}</div>
            <h2 className="text-xl font-bold text-slate-800 group-hover:text-brand transition-colors">
              {c.title}
            </h2>
            <p className="text-slate-500 text-sm">{c.sub}</p>
            <p className="text-brand font-bold text-sm pt-2">{en ? "Open →" : "เปิด →"}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
