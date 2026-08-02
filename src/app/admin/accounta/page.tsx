import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { isRevshareBranch } from "@/lib/revshare-db";
import { HubCard, type HubCardProps } from "@/components/HubCard";

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

  const cta = en ? "Open →" : "เปิด →";
  const eyebrow = en ? "AREA" : "ส่วนงาน";
  const cards: HubCardProps[] = [
    {
      href: "/admin/accounta/daybook", icon: "money", tone: "emerald", eyebrow, cta,
      title: en ? "Income and Expense Account" : "บัญชีรายรับรายจ่าย",
      sub: en
        ? "Record income & expenses, input/output VAT — add income or expense, then view the ledger"
        : "ลงรายรับ-รายจ่าย ภาษีซื้อ-ขาย — เพิ่มรายรับ เพิ่มรายจ่าย แล้วดูบัญชีรายรับรายจ่าย"
    },
    {
      href: "/admin/accounta/inbox", icon: "inbox", tone: "sky", eyebrow, cta,
      title: en ? "Documents to post" : "เอกสารรอลงบัญชี",
      sub: en
        ? "Bills scanned via the LINE OA, grouped by branch — review and post into the ledger"
        : "บิล/ใบเสร็จที่สแกนผ่านน้องฮูก รวมไว้ที่เดียว แยกตามสาขา — ตรวจแล้วยืนยันลงบัญชี"
    },
    {
      href: "/admin/accounta/vendors", icon: "briefcase", tone: "amber", eyebrow, cta,
      title: en ? "Vendors / suppliers" : "ผู้จำหน่าย / คู่ค้า",
      sub: en
        ? "Manage the branch's vendor list — name, tax id, default category (shared with INVENTA)"
        : "จัดการรายชื่อคู่ค้าของสาขา — ชื่อ เลขผู้เสียภาษี หมวดเริ่มต้น (ใช้ร่วมกับ INVENTA)"
    },
    {
      href: "/admin/accounta/company", icon: "building", tone: "violet", eyebrow, cta,
      title: en ? "Company overview (all branches)" : "ภาพรวมบริษัท (รวมสาขา)",
      sub: en
        ? "Combined view across the company's branches — monthly VAT (ภพ.30) filed together, total sales, and a year-end corporate income-tax estimate"
        : "มุมมองรวมทุกสาขาของบริษัท — VAT (ภพ.30) รายเดือนยื่นรวม ยอดขายรวม และประมาณการภาษีเงินได้นิติบุคคลสิ้นปี"
    },
    {
      href: "/admin/accounta/feasibility", icon: "target", tone: "brand", eyebrow, cta,
      title: en ? "Financial Feasibility Study" : "แฟ้มวิเคราะห์โครงการลงทุน",
      sub: en
        ? "Investment project feasibility + initial capital ledger and payback point"
        : "ประเมินความเป็นไปได้ของโปรเจคลงทุน + บัญชีเงินลงทุนตั้งต้น และจุดคืนทุน"
    },
    ...(showRevshare ? [{
      href: "/admin/accounta/revshare", icon: "chart", tone: "rose", eyebrow, cta,
      title: en ? "Revenue-Share (GP)" : "ส่วนแบ่งยอดขาย (GP)",
      sub: en
        ? "Partner sales revenue split by progressive GP tiers — POS import + monthly billing statement"
        : "คำนวณส่วนแบ่งยอดขายจากคู่ค้า (แบ่งขั้นบันได) + นำเข้า POS + ออกใบวางบิลรายเดือน"
    } as HubCardProps] : []),
    ...(user.role === "super_admin" ? [{
      href: "/admin/accounta/access", icon: "shield", tone: "slate", eyebrow, cta,
      title: en ? "Branch access" : "สิทธิ์เข้าถึงตามสาขา",
      sub: en
        ? "Grant each person view / post access to specific branches' accounting"
        : "กำหนดสิทธิ์แต่ละคนว่าเข้าถึง (ดู/ยืนยันลงบัญชี) ของสาขาไหนได้บ้าง"
    } as HubCardProps] : [])
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

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((c) => (
          <HubCard key={c.href} {...c} />
        ))}
      </div>
    </div>
  );
}
