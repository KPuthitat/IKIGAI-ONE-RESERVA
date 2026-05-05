import { requireAdmin } from "@/lib/auth";
import ComingSoon from "../ComingSoon";

export const dynamic = "force-dynamic";

export default function ServiceChargePage() {
  requireAdmin();
  return <ComingSoon feature="Service Charge" />;
}
