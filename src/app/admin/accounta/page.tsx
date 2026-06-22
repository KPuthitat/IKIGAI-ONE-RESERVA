import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { isRevshareBranch } from "@/lib/revshare-db";

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

  const cards = [
    {
      href: "/admin/accounta/daybook",
      title: en ? "Income and Expense Account" : "บัญชีรายรับรายจ่าย",
      sub: en
        ? "Record income & expenses, input/output VAT — add income or expense, then view the ledger"
        : "ลงรายรับ-รายจ่าย ภาษีซื้อ-ขาย — เพิ่มรายรับ เพิ่มรายจ่าย แล้วดูบัญชีรายรับรายจ่าย"
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
