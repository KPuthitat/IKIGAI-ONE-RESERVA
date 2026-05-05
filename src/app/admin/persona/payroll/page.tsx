import { requireAdmin } from "@/lib/auth";
import ComingSoon from "../ComingSoon";

export const dynamic = "force-dynamic";

export default function PayrollPage() {
  requireAdmin();
  return <ComingSoon feature="Payroll" />;
}
