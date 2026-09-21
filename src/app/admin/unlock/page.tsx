import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import AdminUnlockClient from "./AdminUnlockClient";

export const dynamic = "force-dynamic";

// PIN gate before the admin console (owner 2026-09-21). Rendered bare by the
// admin layout (no chrome). `next` is where to land after unlocking; only
// in-app paths are honoured, to avoid an open redirect.
export default function AdminUnlockPage({ searchParams }: { searchParams: { next?: string } }) {
  requireUser(); // logged-out → /login
  const raw = typeof searchParams.next === "string" ? searchParams.next : "";
  // Accept only a same-site absolute path, and never bounce back onto the gate.
  const next = /^\/(?!\/)/.test(raw) && !raw.startsWith("/admin/unlock") ? raw : "/admin";
  return <AdminUnlockClient next={next} />;
}
