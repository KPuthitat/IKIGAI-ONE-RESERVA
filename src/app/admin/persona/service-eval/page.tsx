import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import Client from "./Client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ประเมินการบริการหน้าร้าน · NOKHOOK OS" };

export default function ServiceEvalPage() {
  requireAdmin();
  return <Client />;
}
