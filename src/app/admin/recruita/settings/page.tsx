import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth";
import { getRecruitaChannel } from "@/lib/messaging-channels";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import SettingsClient from "./SettingsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "RECRUITA · ตั้งค่า LINE OA" };

// /admin/recruita/settings — paste IKIGAI Recruit LINE OA
// credentials. Mirrors the /admin/persona/messaging pattern: we show
// the channel row (auto-seeded on first DB open), let the admin
// enter the secret/token/LIFF id, and report which webhook URL to
// paste into the LINE Developers Console.

export default function RecruitaSettingsPage() {
  requireSuperAdmin();
  const lang = getLang();
  const channel = getRecruitaChannel();
  if (!channel) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold text-slate-800">RECRUITA · ตั้งค่า LINE OA</h1>
        <div className="card text-sm text-rose-700 bg-rose-50 border border-rose-200">
          ระบบยังไม่ได้สร้าง channel แถวเริ่มต้น — ลอง restart Next.js
          (db.ts จะ seed แถวให้ตอน boot)
        </div>
      </div>
    );
  }
  const publicBase = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");
  const webhookUrl = `${publicBase}/api/line/webhook/${channel.code}`;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          RECRUITA · <span className="font-medium text-slate-600">{t(lang, "admin.recruita.settings.title")}</span>
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.recruita.settings.subtitle")}
        </p>
      </div>
      <SettingsClient
        code={channel.code}
        label={channel.label}
        hasSecret={!!channel.channel_secret}
        hasToken={!!channel.channel_token}
        liffId={channel.liff_id ?? ""}
        webhookUrl={webhookUrl} />
    </div>
  );
}
