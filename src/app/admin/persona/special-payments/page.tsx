import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listPayments } from "@/lib/special-payments";
import { canPayUser } from "@/lib/special-payments-access";
import Client, { type StaffOption } from "./Client";
import { sqlNameWithPrefix } from "@/lib/name";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "รอบจ่ายกรณีพิเศษ · NOKHOOK OS" };

export default function SpecialPaymentsPage({ searchParams }: { searchParams: { month?: string } }) {
  const user = requirePayrollAccess();
  const nowBkk = new Date(Date.now() + 7 * 3600_000);
  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "") ? (searchParams.month as string) : nowBkk.toISOString().slice(0, 7);
  const staff = (getDb().prepare(`
    SELECT DISTINCT u.id, ${sqlNameWithPrefix("u")} AS name, u.employment_type AS type
      FROM users u
     WHERE u.role IN ('staff', 'admin') AND u.status NOT IN ('disabled', 'resigned', 'terminated') AND COALESCE(u.is_test_account, 0) = 0
     ORDER BY u.display_name
  `).all() as StaffOption[]).filter((s) => canPayUser(user, s.id));
  const payments = listPayments({ yearMonth: month }).filter((p) => canPayUser(user, p.userId));
  return <Client month={month} today={nowBkk.toISOString().slice(0, 10)} staff={staff} payments={payments} />;
}
