import Link from "next/link";
import { getRecruitaChannel, DEFAULT_RECRUITA_OA_LINK } from "@/lib/messaging-channels";
import SettingsClient from "@/app/admin/recruita/settings/SettingsClient";

// /admin/system-settings — RECRUITA LINE OA section.
//
// Lives here (not under /admin/recruita) because the RECRUITA channel
// is a single OA shared across all branches — owner asked for one
// canonical settings location, superadmin-only, applies everywhere.
// The actual UI is reused from src/app/admin/recruita/settings/
// SettingsClient.tsx so there's only one form to maintain; we just
// own the data load + the section wrapper here.

export default function RecruitaOaSection() {
  const channel = getRecruitaChannel();
  if (!channel) {
    return (
      <section id="recruita-oa" className="card text-sm text-rose-700 bg-rose-50 border border-rose-200">
        ระบบยังไม่ได้สร้าง RECRUITA channel แถวเริ่มต้น — ลอง restart Next.js
        (db.ts จะ seed แถวให้ตอน boot)
      </section>
    );
  }
  const publicBase = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");
  const webhookUrl = `${publicBase}/api/line/webhook/${channel.code}`;

  return (
    <section id="recruita-oa" className="space-y-3 pt-6 border-t-2 border-slate-200">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-xl font-bold text-slate-800">
            RECRUITA · ตั้งค่า LINE OA
          </h2>
          <span className="text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
            Global · ทุกสาขา
          </span>
        </div>
        <p className="text-sm text-slate-500 mt-1">
          IKIGAI Recruit OA ใช้ร่วมกันทั้งกลุ่ม — ตั้งครั้งเดียวมีผลทุกสาขา
          (เฉพาะ super admin เท่านั้น)
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          ลิงก์เดิม <Link href="/admin/recruita/settings" className="underline">/admin/recruita/settings</Link>
          {" "}จะ redirect มาที่นี่
        </p>
      </div>

      <SettingsClient
        code={channel.code}
        label={channel.label}
        hasSecret={!!channel.channel_secret}
        hasToken={!!channel.channel_token}
        liffId={channel.liff_id ?? ""}
        liffIdStatus={channel.liff_id_status ?? ""}
        oaLink={channel.oa_link ?? ""}
        oaLinkDefault={DEFAULT_RECRUITA_OA_LINK}
        webhookUrl={webhookUrl} />
    </section>
  );
}
