import { requireAdmin } from "@/lib/auth";
import ComingSoon from "../ComingSoon";

export const dynamic = "force-dynamic";

export default function LeavePage() {
  requireAdmin();
  return <ComingSoon feature="Leave" />;
}
