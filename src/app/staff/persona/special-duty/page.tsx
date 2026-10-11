import type { Metadata } from "next";
import { requireStaffOrAdmin } from "@/lib/auth";
import Client from "./Client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ตำแหน่งงานค่าตอบแทนพิเศษ · NOKHOOK OS" };

export default function SpecialDutyPage({ searchParams }: { searchParams: { month?: string } }) {
  requireStaffOrAdmin();
  const nowBkk = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "") ? (searchParams.month as string) : nowBkk;
  return <Client month={month} />;
}
