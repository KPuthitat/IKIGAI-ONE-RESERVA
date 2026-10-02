// /admin/ir/guide — the same writing guide inside the admin portal, so an
// admin reading it is not bounced into the staff portal (owner 2026-10-02:
// "เด้งไปมาระหว่างโหมด ทำให้เมนูที่ไซด์บาร์ไม่ครบ").
import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth";
import IrGuideContent from "@/app/components/ir/IrGuideContent";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "คู่มือการเขียนรายงานความเสี่ยง (IR) · IR" };

export default function AdminIrGuidePage() {
  requirePermission("ir.manage");
  return <IrGuideContent basePath="/admin/ir" newHref="/admin/ir/reports?new=1" />;
}
