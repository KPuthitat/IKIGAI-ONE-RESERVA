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
        ? "Income & expenses · input/output VAT"
        : "ลงรายรับ-รายจ่าย · ภาษีซื้อ-ขาย"
    },
    {
      href: "/admin/accounta/inbox", icon: "inbox", tone: "sky", eyebrow, cta,
      title: en ? "Documents to post" : "เอกสารรอลงบัญชี",
      sub: en
        ? "Scanned bills by branch · review & post"
        : "บิล/ใบเสร็จจากน้องฮูก · ตรวจแล้วลงบัญชี"
    },
    {
      href: "/admin/accounta/vendors", icon: "briefcase", tone: "amber", eyebrow, cta,
      title: en ? "Vendors / suppliers" : "ผู้จำหน่าย / คู่ค้า",
      sub: en
        ? "Vendors · tax id · default category"
        : "รายชื่อคู่ค้า · เลขภาษี · หมวดเริ่มต้น"
    },
    {
      href: "/admin/accounta/company", icon: "building", tone: "violet", eyebrow, cta,
      title: en ? "Company overview (all branches)" : "ภาพรวมบริษัท (รวมสาขา)",
      sub: en
        ? "All branches · VAT ภพ.30 · year-end tax estimate"
        : "รวมทุกสาขา · VAT ภพ.30 · ประมาณการภาษีสิ้นปี"
    },
    {
      href: "/admin/accounta/feasibility", icon: "target", tone: "brand", eyebrow, cta,
      title: en ? "Financial Feasibility Study" : "แฟ้มวิเคราะห์โครงการลงทุน",
      sub: en
        ? "Investment feasibility · payback point"
        : "ความเป็นไปได้โปรเจคลงทุน · จุดคืนทุน"
    },
    ...(showRevshare ? [{
      href: "/admin/accounta/revshare", icon: "chart", tone: "rose", eyebrow, cta,
      title: en ? "Revenue-Share (GP)" : "ส่วนแบ่งยอดขาย (GP)",
      sub: en
        ? "GP tiers · POS import · billing statement"
        : "แบ่ง GP ขั้นบันได · นำเข้า POS · ใบวางบิล"
    } as HubCardProps] : []),
    ...(user.role === "super_admin" ? [{
      href: "/admin/accounta/access", icon: "shield", tone: "slate", eyebrow, cta,
      title: en ? "Branch access" : "สิทธิ์เข้าถึงตามสาขา",
      sub: en
        ? "Per-branch view / post access"
        : "กำหนดสิทธิ์เข้าถึงบัญชีตามสาขา"
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

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((c) => (
          <HubCard key={c.href} compact {...c} />
        ))}
      </div>
    </div>
  );
}
