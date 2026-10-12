import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import Client from "./Client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ประกาศนโยบาย · NOKHOOK OS" };

export default function PolicyNoticesAdminPage() {
  requireAdmin();
  return <Client />;
}
