"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import Switch from "@/app/components/Switch";

export type ReservaChannelInitial = {
  code: string;
  label: string;
  branch_id: number | null;
  has_token: boolean;
  has_secret: boolean;
  liff_id: string | null;
  updated_at: string;
  // Branch-level LINE notification settings (consolidated here so admin
  // doesn't need to hop between /settings and /messaging).
  staff_group_id: string | null;
  extra_button_url: string | null;        // Menu link on Flex card
  contact_phone: string | null;           // tel: button on Flex card
  // Per-event audience toggles (SQLite 0/1). The UI flips booleans.
  notify_customer_pending: number;
  notify_customer_created: number;
  notify_customer_reminder: number;
  notify_staff_pending: number;
  notify_staff_created: number;
  notify_staff_reminder: number;
};

export default function ReservaMessagingClient({
  lang, channels
}: { lang: Lang; channels: ReservaChannelInitial[] }) {
  return (
    <div className="space-y-4">
      {channels.length === 0 ? (
        <div className="card text-sm text-slate-500 text-center py-8">
          {t(lang, "admin.reserva.messaging.noChannels")}
        </div>
      ) : (
        channels.map((c) => (
          <ChannelCard key={c.code} lang={lang} channel={c} />
        ))
      )}

      {/* Setup steps reminder */}
      <div className="card text-sm text-slate-700 space-y-2">
        <h3 className="font-semibold text-slate-800">
          {t(lang, "admin.reserva.messaging.howto.title")}
        </h3>
        <ol className="list-decimal pl-5 space-y-1 text-xs leading-relaxed">
          <li>{t(lang, "admin.reserva.messaging.howto.step1")}</li>
          <li>{t(lang, "admin.reserva.messaging.howto.step2")}</li>
          <li>{t(lang, "admin.reserva.messaging.howto.step3")}</li>
          <li>{t(lang, "admin.reserva.messaging.howto.step4")}</li>
          <li>{t(lang, "admin.reserva.messaging.howto.step5")}</li>
        </ol>
      </div>
    </div>
  );
}

function ChannelCard({
  lang, channel
}: { lang: Lang; channel: ReservaChannelInitial }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Channel credentials state (token / secret / liff_id). Token + secret
  // use a "type-to-replace, leave-blank-to-keep" pattern because they're
  // sensitive values we don't echo back.
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [liffId, setLiffId] = useState(channel.liff_id ?? "");
  const [clearAll, setClearAll] = useState(false);

  // Branch-level notification state. These come back from the server as
  // plain strings so we can edit and re-send. Null becomes "" for input
  // compatibility; saved as null when blank.
  const [staffGroupId, setStaffGroupId] = useState(channel.staff_group_id ?? "");
  const [extraButtonUrl, setExtraButtonUrl] = useState(channel.extra_button_url ?? "");
  const [contactPhone, setContactPhone] = useState(channel.contact_phone ?? "");

  // Per-event audience toggles (UI as booleans, persisted as 0/1).
  const [notifyCustPending,  setNotifyCustPending]  = useState(!!channel.notify_customer_pending);
  const [notifyCustCreated,  setNotifyCustCreated]  = useState(!!channel.notify_customer_created);
  const [notifyCustReminder, setNotifyCustReminder] = useState(!!channel.notify_customer_reminder);
  const [notifyStaffPending,  setNotifyStaffPending]  = useState(!!channel.notify_staff_pending);
  const [notifyStaffCreated,  setNotifyStaffCreated]  = useState(!!channel.notify_staff_created);
  const [notifyStaffReminder, setNotifyStaffReminder] = useState(!!channel.notify_staff_reminder);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const webhookUrl = typeof window !== "undefined"
    ? `${window.location.origin}/api/line/webhook/${channel.code}`
    : `https://your-domain/api/line/webhook/${channel.code}`;

  const isReady = channel.has_token && channel.has_secret;

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      // ── 1. Channel credentials ─────────────────────────────────────
      const channelBody: Record<string, string> = {};
      if (clearAll) {
        channelBody.channel_token = "";
        channelBody.channel_secret = "";
      } else {
        if (token.trim()) channelBody.channel_token = token.trim();
        if (secret.trim()) channelBody.channel_secret = secret.trim();
      }
      const liffTrimmed = liffId.trim();
      const liffChanged = liffTrimmed !== (channel.liff_id ?? "");
      if (liffChanged) channelBody.liff_id = liffTrimmed;

      // ── 2. Branch-level notification fields ────────────────────────
      const branchBody: Record<string, string | boolean | null> = {};
      const branchPairs: Array<[keyof typeof channel, string | null, string]> = [
        ["staff_group_id", staffGroupId.trim() || null, channel.staff_group_id ?? ""],
        ["extra_button_url", extraButtonUrl.trim() || null, channel.extra_button_url ?? ""],
        ["contact_phone", contactPhone.trim() || null, channel.contact_phone ?? ""]
      ];
      for (const [key, newVal, oldVal] of branchPairs) {
        if ((newVal ?? "") !== oldVal) branchBody[key] = newVal;
      }

      // Audience toggles — only include the keys that actually changed,
      // converted to boolean for the API (the route maps booleans to
      // SQLite 0/1 ints before the UPDATE).
      const togglePairs: Array<[keyof typeof channel, boolean]> = [
        ["notify_customer_pending",  notifyCustPending],
        ["notify_customer_created",  notifyCustCreated],
        ["notify_customer_reminder", notifyCustReminder],
        ["notify_staff_pending",     notifyStaffPending],
        ["notify_staff_created",     notifyStaffCreated],
        ["notify_staff_reminder",    notifyStaffReminder]
      ];
      for (const [key, newBool] of togglePairs) {
        if (newBool !== !!channel[key]) branchBody[key] = newBool;
      }

      const noChannelChange = Object.keys(channelBody).length === 0;
      const noBranchChange = Object.keys(branchBody).length === 0;
      if (noChannelChange && noBranchChange) {
        setMsg({ kind: "err", text: t(lang, "admin.messaging.err.noChange") });
        setBusy(false);
        return;
      }

      // Fire both updates in parallel; messaging endpoint owns channel
      // credentials, branch endpoint owns notification preferences.
      const tasks: Promise<Response>[] = [];
      if (!noChannelChange) {
        tasks.push(fetch(
          apiUrl(`/api/admin/messaging/channel/${channel.code}`),
          { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(channelBody) }
        ));
      }
      if (!noBranchChange && channel.branch_id != null) {
        tasks.push(fetch(
          apiUrl(`/api/admin/branch/${channel.branch_id}`),
          { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(branchBody) }
        ));
      }
      const responses = await Promise.all(tasks);
      const allOk = responses.every((r) => r.ok);
      if (!allOk) {
        setMsg({ kind: "err", text: t(lang, "common.error") });
        setBusy(false);
        return;
      }
      setMsg({ kind: "ok", text: t(lang, "common.saved") });
      setToken("");
      setSecret("");
      setClearAll(false);
      startTransition(() => router.refresh());
    } catch {
      setMsg({ kind: "err", text: t(lang, "common.error") });
    } finally {
      setBusy(false);
    }
  }

  function copyWebhook(): void {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(webhookUrl);
      setMsg({ kind: "ok", text: t(lang, "admin.messaging.urlCopied") });
    }
  }

  return (
    <div className="card space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-semibold text-slate-800">{channel.label}</h2>
            <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${
              isReady ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
            }`}>
              {isReady
                ? t(lang, "admin.messaging.statusReady")
                : t(lang, "admin.messaging.statusNotConfigured")}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {t(lang, "admin.reserva.messaging.channelHint", { slug: channel.code })}
          </p>
        </div>
      </div>

      {/* ───────── Channel credentials section ───────── */}
      <SectionTitle>{t(lang, "admin.reserva.messaging.section.channel")}</SectionTitle>

      {/* Webhook URL */}
      <div>
        <label className="label">
          {t(lang, "admin.messaging.webhookUrl")}
        </label>
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            readOnly
            className="input text-sm flex-1"
            value={webhookUrl}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            onClick={copyWebhook}
            className="px-3 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
          >
            {t(lang, "admin.messaging.copy")}
          </button>
        </div>
      </div>

      {/* Token */}
      <div>
        <label className="label">
          {t(lang, "admin.messaging.token")}
          {channel.has_token && (
            <span className="ml-2 text-[10px] text-emerald-700 font-medium">
              · {t(lang, "admin.messaging.alreadySet")}
            </span>
          )}
        </label>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="input text-sm"
          value={token}
          onChange={(e) => { setToken(e.target.value); setClearAll(false); }}
          placeholder={channel.has_token
            ? t(lang, "admin.messaging.tokenPlaceholderKeep")
            : t(lang, "admin.messaging.tokenPlaceholder")}
          disabled={clearAll}
        />
      </div>

      {/* Secret */}
      <div>
        <label className="label">
          {t(lang, "admin.messaging.secret")}
          {channel.has_secret && (
            <span className="ml-2 text-[10px] text-emerald-700 font-medium">
              · {t(lang, "admin.messaging.alreadySet")}
            </span>
          )}
        </label>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="input text-sm"
          value={secret}
          onChange={(e) => { setSecret(e.target.value); setClearAll(false); }}
          placeholder={channel.has_secret
            ? t(lang, "admin.messaging.secretPlaceholderKeep")
            : t(lang, "admin.messaging.secretPlaceholder")}
          disabled={clearAll}
        />
      </div>

      {/* LIFF ID */}
      <div>
        <label className="label">
          {t(lang, "admin.reserva.messaging.liffId")}
          {channel.liff_id && (
            <span className="ml-2 text-[10px] text-emerald-700 font-medium">
              · {t(lang, "admin.messaging.alreadySet")}
            </span>
          )}
        </label>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          className="input text-sm"
          value={liffId}
          onChange={(e) => setLiffId(e.target.value)}
          placeholder="2010019217-xxxxxxxx"
        />
        <p className="text-xs text-slate-500 mt-1">
          {t(lang, "admin.reserva.messaging.liffIdHint")}
        </p>
      </div>

      {/* Clear toggle */}
      {(channel.has_token || channel.has_secret) && (
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={clearAll}
            onChange={(e) => {
              setClearAll(e.target.checked);
              if (e.target.checked) { setToken(""); setSecret(""); }
            }}
          />
          {t(lang, "admin.messaging.clearBoth")}
        </label>
      )}

      {/* ───────── Notifications section ───────── */}
      <SectionTitle>{t(lang, "admin.reserva.messaging.section.notifications")}</SectionTitle>

      {/* Staff LINE group */}
      <div>
        <label className="label">{t(lang, "admin.settings.field.staffGroupId")}</label>
        <input className="input text-xs"
          type="text"
          autoComplete="off"
          value={staffGroupId} maxLength={100}
          onChange={(e) => setStaffGroupId(e.target.value.trim())}
          placeholder="Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
        <p className="text-xs text-slate-500 mt-1 whitespace-pre-line">
          {t(lang, "admin.settings.staffGroupIdHint")}
        </p>
      </div>

      {/* Contact phone */}
      <div>
        <label className="label">{t(lang, "admin.settings.field.contactPhone")}</label>
        <input className="input"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={contactPhone} maxLength={40}
          onChange={(e) => setContactPhone(e.target.value)}
          placeholder="038-xxx-xxxx" />
        <p className="text-xs text-slate-500 mt-1">
          {t(lang, "admin.settings.contactPhoneHint")}
        </p>
      </div>

      {/* Menu button URL */}
      <div>
        <label className="label">{t(lang, "admin.settings.field.menuBtnUrl")}</label>
        <input className="input"
          type="url"
          value={extraButtonUrl} maxLength={500}
          onChange={(e) => setExtraButtonUrl(e.target.value)}
          placeholder="https://drive.google.com/..." />
        <p className="text-xs text-slate-500 mt-1">
          {t(lang, "admin.settings.menuBtnHint")}
        </p>
      </div>

      {/* ───────── Audience toggles ───────── */}
      <SectionTitle>{t(lang, "admin.reserva.messaging.section.notifyAudience")}</SectionTitle>
      <p className="text-xs text-slate-500 -mt-1">
        {t(lang, "admin.reserva.messaging.notify.audienceHint")}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-1">
        <AudienceCard
          accent="rose"
          heading={t(lang, "admin.reserva.messaging.notify.customer")}
          subtitle={t(lang, "admin.reserva.messaging.notify.customerSubtitle")}
          rows={[
            { label: t(lang, "admin.reserva.messaging.notify.pending"),
              desc:  t(lang, "admin.reserva.messaging.notify.descCustPending"),
              value: notifyCustPending,  set: setNotifyCustPending },
            { label: t(lang, "admin.reserva.messaging.notify.created"),
              desc:  t(lang, "admin.reserva.messaging.notify.descCustCreated"),
              value: notifyCustCreated,  set: setNotifyCustCreated },
            { label: t(lang, "admin.reserva.messaging.notify.reminder"),
              desc:  t(lang, "admin.reserva.messaging.notify.descCustReminder"),
              value: notifyCustReminder, set: setNotifyCustReminder }
          ]}
        />
        <AudienceCard
          accent="sky"
          heading={t(lang, "admin.reserva.messaging.notify.staff")}
          subtitle={t(lang, "admin.reserva.messaging.notify.staffSubtitle")}
          rows={[
            { label: t(lang, "admin.reserva.messaging.notify.pending"),
              desc:  t(lang, "admin.reserva.messaging.notify.descStaffPending"),
              value: notifyStaffPending,  set: setNotifyStaffPending },
            { label: t(lang, "admin.reserva.messaging.notify.created"),
              desc:  t(lang, "admin.reserva.messaging.notify.descStaffCreated"),
              value: notifyStaffCreated,  set: setNotifyStaffCreated },
            { label: t(lang, "admin.reserva.messaging.notify.reminder"),
              desc:  t(lang, "admin.reserva.messaging.notify.descStaffReminder"),
              value: notifyStaffReminder, set: setNotifyStaffReminder }
          ]}
        />
      </div>

      <div className="flex items-center justify-between gap-3 pt-1 border-t border-slate-100">
        {msg && (
          <span className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
            {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
          </span>
        )}
        <button type="button" onClick={save} disabled={busy}
          className="btn-primary text-sm ml-auto">
          {busy ? t(lang, "common.submitting") : t(lang, "common.save")}
        </button>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="pt-2 -mx-1 px-1 border-t border-slate-100">
      <h3 className="text-xs font-bold text-slate-700 tracking-wider uppercase pt-3 pb-1">
        {children}
      </h3>
    </div>
  );
}

// Two-column card showing one audience's three event toggles. Per-row
// label + small description + iOS-style switch on the right. Active
// rows use a brand-tinted background so the eye can scan which kinds
// are on at a glance.
function AudienceCard({
  heading, subtitle, accent, rows
}: {
  heading: string;
  subtitle: string;
  accent: "rose" | "sky";
  rows: Array<{ label: string; desc: string; value: boolean; set: (v: boolean) => void }>;
}) {
  const dotCls = accent === "rose" ? "bg-rose-500" : "bg-sky-500";
  const activeRowCls = accent === "rose" ? "bg-rose-50/40" : "bg-sky-50/40";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-start gap-2 mb-3">
        <span className={`w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0 ${dotCls}`} />
        <div className="min-w-0">
          <div className="font-bold text-slate-800">{heading}</div>
          <div className="text-xs text-slate-500 mt-0.5 leading-snug">{subtitle}</div>
        </div>
      </div>
      <div className="divide-y divide-slate-100 -mx-2">
        {rows.map((r) => (
          <label
            key={r.label}
            className={`w-full flex items-start justify-between gap-3 px-2 py-2.5 rounded-lg cursor-pointer transition ${
              r.value ? activeRowCls : "hover:bg-slate-50/60"
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-medium leading-tight ${r.value ? "text-slate-800" : "text-slate-500"}`}>
                {r.label}
              </div>
              <div className={`text-xs leading-snug mt-0.5 ${r.value ? "text-slate-500" : "text-slate-400"}`}>
                {r.desc}
              </div>
            </div>
            <span className="mt-0.5">
              <Switch checked={r.value} onChange={r.set} accent={accent} />
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
