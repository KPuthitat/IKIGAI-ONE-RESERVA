import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { listReservaChannels } from "@/lib/messaging-channels";
import ReservaMessagingClient from "./ReservaMessagingClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ตั้งค่า LINE OA · RESERVA" };

export default function ReservaMessagingPage() {
  requireAdmin();
  const lang = getLang();

  // Channel info (token / secret / liff_id) lives on messaging_channels;
  // notification preferences (group, user-id fallback, contact phone, menu
  // URL) live on the branch row. We load both here so the messaging page
  // can offer a single per-branch card that consolidates every LINE-OA
  // setting in one place.
  const db = getDb();
  const channels = listReservaChannels().map((c) => {
    const branch = c.branch_id != null
      ? (db.prepare("SELECT * FROM branches WHERE id = ?")
          .get(c.branch_id) as Branch | undefined)
      : undefined;
    return {
      code: c.code,
      label: c.label,
      branch_id: c.branch_id,
      has_token: !!c.channel_token,
      has_secret: !!c.channel_secret,
      liff_id: c.liff_id,
      updated_at: c.updated_at,
      // Branch-level notification settings (null when no branch is linked,
      // but every reserva channel has a branch).
      staff_group_id: branch?.staff_group_id ?? null,
      extra_button_url: branch?.extra_button_url ?? null,
      contact_phone: branch?.contact_phone ?? null
    };
  });

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
