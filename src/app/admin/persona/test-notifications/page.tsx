import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import TestNotificationsClient from "./TestNotificationsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ทดสอบการแจ้งเตือน · PERSONA" };

// Developer / QA surface — gives admin a single page of buttons to
// preview every Flex card we send. Each button POSTs to
// /api/admin/persona/test-notification with a `kind`, which builds a
// mock payload and pushes the resulting Flex to either the admin's
// own LINE (most cards) or the executive group (attendance summary).
// No DB writes — pure push.
export default function TestNotificationsPage() {
  const user = requireAdmin();
  const lang = getLang();
  void user; // requireAdmin is the auth check; we don't need fields here
  void lang;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          ทดสอบการแจ้งเตือน
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          กดปุ่มเพื่อส่งการ์ดทดสอบเข้า LINE ของคุณ (หรือกลุ่ม executive
          สำหรับการ์ดที่ตั้งใจส่งเข้ากลุ่ม) ใช้ดู layout จริงโดยไม่ต้อง
          รอเหตุการณ์เกิดขึ้น
        </p>
      </div>
      <TestNotificationsClient />
    </div>
  );
}
