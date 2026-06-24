// /admin/notifications-catalog — one place to PREVIEW every LINE card the
// system can send, rendered from the real builders with sample data via a
// generic Flex renderer (owner 2026-06-24: "พรีวิวการ์ดแจ้งเตือนทุกแบบ").
// Read-only catalogue — nothing is sent from here.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import FlexRenderer from "./FlexRenderer";
import { revshareDailyFlex, revshareWeeklyFlex, revshareSettlementFlex } from "@/lib/revshare-line";
import { pendingDigestFlex } from "@/lib/pending-digest";
import { personaClockInFlex, disciplinaryWarningFlex, customerBookingFlex, staffBookingFlex } from "@/lib/line";
import { stageChangeFlex } from "@/lib/recruita-notify";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "แคตตาล็อกการ์ดแจ้งเตือน · IKIGAI OS" };

type CatalogCard = { module: string; name: string; trigger: "กดเอง" | "อัตโนมัติ"; bubble: Record<string, unknown> };

// Each entry calls the real builder with sample data. Wrapped so one bad
// builder can't blank the whole page.
function build(fn: () => { contents: unknown }): Record<string, unknown> | null {
  try { const c = fn().contents; return c && typeof c === "object" ? (c as Record<string, unknown>) : null; } catch { return null; }
}

function cards(): CatalogCard[] {
  const out: CatalogCard[] = [];
  const add = (module: string, name: string, trigger: "กดเอง" | "อัตโนมัติ", b: Record<string, unknown> | null) => {
    if (b) out.push({ module, name, trigger, bubble: b });
  };

  // ── ACCOUNTA / ส่วนแบ่งยอดขาย (GP) ──
  add("ACCOUNTA · ส่วนแบ่งยอดขาย", "สรุปยอดขายประจำวัน", "กดเอง", build(() => revshareDailyFlex({
    shop: "จ้อจี้ & friends", sellerName: "HYPOPLARAEMIA", dateLabel: "19 มิถุนายน 2569", sales: 12285.32, vatRate: 0.07
  })));
  add("ACCOUNTA · ส่วนแบ่งยอดขาย", "สรุปยอดขายประจำสัปดาห์", "กดเอง", build(() => revshareWeeklyFlex({
    shop: "จ้อจี้ & friends", sellerName: "HYPOPLARAEMIA", weekLabel: "15–21 มิถุนายน 2569", transferAmount: 108211.96, dayCount: 7, vatRate: 0.07
  })));
  add("ACCOUNTA · ส่วนแบ่งยอดขาย", "สรุปยอดขายประจำเดือน + ส่วนแบ่ง", "กดเอง", build(() => revshareSettlementFlex({
    shop: "จ้อจี้ & friends", sellerName: "HYPOPLARAEMIA", sellerCompany: "บริษัท อิคิไก เวลล์เทรด จำกัด",
    partnerName: "บริษัท ศาลาชิลล์ จำกัด", monthLabel: "มิถุนายน 2569",
    totalSales: 123814.38, tierGP: 22286.59, floorApplied: 20000, topup: 0, billedGP: 22286.59, avgGpPct: 0.18,
    vatEnabled: true, vatAmount: 1560.06, whtAmount: 668.60, netAmount: 23178.05, invoiceNo: null
  })));

  // ── PERSONA ──
  add("PERSONA", "สรุปคำขอค้างประจำวัน", "อัตโนมัติ", build(() => pendingDigestFlex({
    branchName: "NAMA PASTA SRIRACHA", reportDate: "24 มิถุนายน 2569",
    digest: {
      shiftChange: [{ name: "นาย ก", detail: "ขอเพิ่มกะ · 2026-06-25", ref: "SC2569-12" }],
      leave: [{ name: "นางสาว ข", detail: "ลาป่วย · 2026-06-26", ref: "L2569-5" }],
      ot: [],
      accountaDraft: [{ name: "ร้านวัตถุดิบเอ", detail: "รอตรวจสอบ · 1,200.00 บาท · 2026-06-23", ref: null }],
      accountaUnpaid: [{ name: "บริษัทแก๊สบี", detail: "ค้างชำระ · 3,500.00 บาท · 2026-06-20", ref: null }]
    }
  })));
  add("PERSONA", "ยืนยันลงเวลาเข้างาน", "อัตโนมัติ", build(() => personaClockInFlex({
    displayName: "สมชาย ใจดี", clockInIsoTs: "2026-06-24T01:02:00.000Z", branchName: "NAMA PASTA SRIRACHA",
    lunchStart: "12:00", lunchEnd: "13:00", hasLunchToday: true, personaUrl: "https://ikigaimedihealth.com/staff/persona"
  })));
  add("PERSONA", "หนังสือเตือน (วินัย)", "อัตโนมัติ", build(() => disciplinaryWarningFlex({
    branchName: "NAMA PASTA SRIRACHA", recipientName: "สมหญิง รักงาน", severity: "written_1",
    title: "มาสายเกินกำหนด 3 ครั้งในเดือน", refNo: "DW2569-3", staffUrl: "https://ikigaimedihealth.com/staff/persona/discipline"
  })));

  // ── RESERVA (จองโต๊ะ) ──
  add("RESERVA", "ยืนยันการจอง (ลูกค้า)", "กดเอง", build(() => customerBookingFlex({
    branchName: "NAMA PASTA SRIRACHA", branchSlug: "nama", bookingId: 1, bookingRef: "R20260600001",
    customerName: "คุณเอ", partySize: 4, bookingDate: "2026-06-25", bookingTime: "19:00", notes: "ขอโต๊ะริมหน้าต่าง",
    publicBaseUrl: "https://ikigaimedihealth.com", kind: "created", lang: "th",
    contactPhone: "0843931355", verificationCode: "A1B2C3"
  })));
  add("RESERVA", "แจ้งพนักงาน (จองใหม่)", "อัตโนมัติ", build(() => staffBookingFlex({
    branchName: "NAMA PASTA SRIRACHA", bookingId: 1, bookingRef: "R20260600001", customerName: "คุณเอ",
    customerPhone: "0812345678", partySize: 4, bookingDate: "2026-06-25", bookingTime: "19:00", tableLabel: "T3",
    notes: "ขอโต๊ะริมหน้าต่าง", foodAllergy: "แพ้ถั่ว", source: "LINE", occasion: null,
    publicBaseUrl: "https://ikigaimedihealth.com", kind: "created", lang: "th"
  })));

  // ── RECRUITA ──
  add("RECRUITA", "เปลี่ยนสเตจผู้สมัคร (ผู้สมัคร)", "กดเอง", build(() => stageChangeFlex({
    applicantName: "ชัยวัฒน์ ตั้งใจ", positionTitle: "พนักงานเสิร์ฟ", branchName: "NAMA PASTA SRIRACHA",
    stage: "interview", applicationNo: "AP2569-21"
  }) as unknown as { contents: unknown }));

  return out;
}

export default function NotificationsCatalogPage() {
  requireAdmin();
  const list = cards();
  const modules = [...new Set(list.map((c) => c.module))];
  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin" className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-1">แคตตาล็อกการ์ดแจ้งเตือน</h1>
        <p className="text-sm text-slate-500 mt-1">
          ตัวอย่างการ์ดแจ้งเตือน LINE ทุกแบบที่ระบบส่ง (ข้อมูลตัวอย่าง) — ดูอย่างเดียว ไม่มีการส่งจริงจากหน้านี้ ·
          แสดง {list.length} แบบ
        </p>
      </div>
      {modules.map((mod) => (
        <div key={mod} className="space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500 border-b border-slate-200 pb-1">{mod}</h2>
          <div className="flex flex-wrap gap-5">
            {list.filter((c) => c.module === mod).map((c, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-700">{c.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${c.trigger === "กดเอง" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{c.trigger}</span>
                </div>
                <FlexRenderer bubble={c.bubble} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
