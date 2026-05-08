import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { listReservaChannels } from "@/lib/messaging-channels";
import ReservaMessagingClient from "./ReservaMessagingClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ตั้งค่า LINE OA · RESERVA" };

export default function ReservaMessagingPage() {
  requireAdmin();
  const lang = getLang();

  const channels = listReservaChannels().map((c) => ({
    code: c.code,
    label: c.label,
    has_token: !!c.channel_token,
    has_secret: !!c.channel_secret,
    updated_at: c.updated_at
  }));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.reserva.messaging.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.reserva.messaging.subtitle")}
        </p>
      </div>
      <ReservaMessagingClient lang={lang} channels={channels} />
    </div>
  );
}
