import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import Client from "./Client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ตั้งค่าตำแหน่งงานค่าตอบแทนพิเศษ · NOKHOOK OS" };

export default function SpecialDutySettingsPage({ searchParams }: { searchParams: { month?: string; branch?: string } }) {
  requireAdmin();
  const nowBkk = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "") ? (searchParams.month as string) : nowBkk;
  return <Client month={month} branch={Number(searchParams.branch) || null} />;
}
