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
  const user = requireAdmin();
  const lang = getLang();

  // Channel info (token / secret / liff_id) lives on messaging_channels;
  // notification preferences (group, user-id fallback, contact phone, menu
  // URL) live on the branch row. We load both here so the messaging page
  // can offer a single per-branch card that consolidates every LINE-OA
  // setting in one place.
  const db = getDb();

  // Scope to the admin's currently-selected branch only — EVERYONE,
  // including super_admin, sees just the active branch's OA card so the
  // page isn't a confusing wall of every branch. To manage another
  // branch, switch via the branch picker.
  const branchId = user.activeBranchId;
  if (branchId == null) {
    return (
      <div className="card text-sm text-slate-600">
        {t(lang, "admin.notAssignedBranch")}
      </div>
    );
  }
  const branchRow = db.prepare("SELECT id, name FROM branches WHERE id = ?")
    .get(branchId) as { id: number; name: string } | undefined;

  const channels = listReservaChannels()
    .filter((c) => c.branch_id === branchId)
    .map((c) => {
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
        contact_phone: branch?.contact_phone ?? null,
        notify_customer_pending: branch?.notify_customer_pending ?? 1,
        notify_customer_created: branch?.notify_customer_created ?? 1,
        notify_customer_reminder: branch?.notify_customer_reminder ?? 1,
        notify_staff_pending: branch?.notify_staff_pending ?? 1,
        notify_staff_created: branch?.notify_staff_created ?? 1,
        notify_staff_reminder: branch?.notify_staff_reminder ?? 0
      };
    });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.reserva.messaging.title")}
          {branchRow && (
            <span className="ml-2 text-sm font-medium text-brand">· {branchRow.name}</span>
          )}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.reserva.messaging.subtitle")}
        </p>
      </div>
      <ReservaMessagingClient lang={lang} channels={channels} />
    </div>
  );
}
