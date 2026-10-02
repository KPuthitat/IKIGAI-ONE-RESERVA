// /staff/ir/guide — คู่มือการเขียนรายงานความเสี่ยง (IR) สำหรับพนักงานทุกคน
// (owner 2026-10-01). The text lives in IrGuideContent, shared with /admin/ir/guide.
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import IrGuideContent from "@/app/components/ir/IrGuideContent";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "คู่มือการเขียนรายงานความเสี่ยง (IR)" };

export default function IrGuidePage() {
  requireUser();
  return <IrGuideContent basePath="/staff/ir" newHref="/staff/ir/new" />;
}
