import { requireAdmin } from "@/lib/auth";
import ComingSoon from "../ComingSoon";

export const dynamic = "force-dynamic";

export default function ReportsPage() {
  requireAdmin();
  return <ComingSoon feature="Reports" />;
}
