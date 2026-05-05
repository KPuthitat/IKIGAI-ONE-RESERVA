import { requireAdmin } from "@/lib/auth";
import ComingSoon from "../ComingSoon";

export const dynamic = "force-dynamic";

export default function EmployeesPage() {
  requireAdmin();
  return <ComingSoon feature="Employees" />;
}
