import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDeliveraChannel } from "@/lib/messaging-channels";
import ConnectionClient from "./ConnectionClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "เชื่อมต่อ LINE · DELIVERA" };

function view(kind: "customer" | "rider") {
  const c = getDeliveraChannel(kind);
  // Never ship secrets to the client — only whether they exist + the public LIFF id.
  return {
    kind,
    label: c?.label ?? (kind === "customer" ? "DELIVERA · ลูกค้า" : "DELIVERA · ทีมงานส่งสุข"),
    has_token: !!c?.channel_token,
    has_secret: !!c?.channel_secret,
    liff_id: c?.liff_id ?? "",
    updated_at: c?.updated_at ?? null
  };
}

export default function DeliveraConnectionPage() {
  requireAdmin();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">เชื่อมต่อ LINE · DELIVERA</h1>
          <p className="text-sm text-slate-500">กรอก token / secret / LIFF ของช่องลูกค้าและทีมงานส่งสุข (ใช้ร่วมทุกสาขา)</p>
        </div>
        <Link href="/admin/delivera/settings" className="text-sm text-slate-500 hover:text-brand">← ตั้งค่า / เมนู</Link>
      </div>
      <ConnectionClient customer={view("customer")} rider={view("rider")} />
    </div>
  );
}
