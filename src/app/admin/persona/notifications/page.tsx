// /admin/persona/notifications — central hub for customising the
// text on LINE notification cards. Each "template" has an editor +
// a side-by-side HTML preview that approximates the LINE Flex
// layout so admin can see what staff will receive before saving.
//
// Phase 1 ships only the resignation-unlock card (the one config
// that already had a settings column). Future phases add shift
// reminder + approval notify + daily attendance summary by adding
// a new entry to the TEMPLATES array in NotificationsClient.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getSystemSettings } from "@/lib/db";
import NotificationsClient from "./NotificationsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ปรับแต่งการ์ดแจ้งเตือน · PERSONA" };

export default function NotificationsPage() {
  requireAdmin();
  const ss = getSystemSettings();
  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ
        </Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">
          ปรับแต่งการ์ดแจ้งเตือน
        </h1>
        <p className="text-sm text-slate-500">
          แก้ข้อความบนการ์ด LINE ที่ระบบส่งหาพนักงาน · มีพรีวิวด้านขวาให้ดูก่อนบันทึก
        </p>
      </div>
      <NotificationsClient
        resignationUnlockMessage={ss.resignation_unlock_message ?? ""}
      />
    </div>
  );
}
