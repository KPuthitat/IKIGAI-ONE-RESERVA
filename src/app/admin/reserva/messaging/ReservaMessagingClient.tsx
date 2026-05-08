"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";

export type ReservaChannelInitial = {
  code: string;
  label: string;
  has_token: boolean;
  has_secret: boolean;
  updated_at: string;
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
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [clearAll, setClearAll] = useState(false);
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
      const body: Record<string, string> = {};
      if (clearAll) {
        body.channel_token = "";
        body.channel_secret = "";
      } else {
        if (token.trim()) body.channel_token = token.trim();
        if (secret.trim()) body.channel_secret = secret.trim();
      }
      if (Object.keys(body).length === 0) {
        setMsg({ kind: "err", text: t(lang, "admin.messaging.err.noChange") });
        setBusy(false);
        return;
      }
      const res = await fetch(
        apiUrl(`/api/admin/messaging/channel/${channel.code}`),
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        setMsg({ kind: "ok", text: t(lang, "common.saved") });
        setToken("");
        setSecret("");
        setClearAll(false);
        startTransition(() => router.refresh());
      } else {
        setMsg({ kind: "err", text: j?.error ?? t(lang, "common.error") });
      }
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
    <div className="card space-y-4">
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

      {/* Webhook URL */}
      <div>
        <label className="label">
          {t(lang, "admin.messaging.webhookUrl")}
        </label>
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            readOnly
            className="input font-mono text-xs flex-1"
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
          className="input font-mono text-xs"
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
          className="input font-mono text-xs"
          value={secret}
          onChange={(e) => { setSecret(e.target.value); setClearAll(false); }}
          placeholder={channel.has_secret
            ? t(lang, "admin.messaging.secretPlaceholderKeep")
            : t(lang, "admin.messaging.secretPlaceholder")}
          disabled={clearAll}
        />
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

      <div className="flex items-center justify-between gap-3 pt-1">
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
