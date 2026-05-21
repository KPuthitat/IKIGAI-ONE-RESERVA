"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import Switch from "@/app/components/Switch";

export type PlatformChannelInitial = {
  label: string;
  code: string;
  has_token: boolean;
  has_secret: boolean;
  updated_at: string | null;
};

export default function MessagingClient({
  lang, platform
}: { lang: Lang; platform: PlatformChannelInitial }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [clearAll, setClearAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Webhook URL — Next.js is mounted at the domain root after Deploy V2
  // (Nginx forwards / → port 3010, no /reserva prefix). Build the URL from
  // the current origin so it adapts to any host the admin is browsing on.
  const webhookUrl = typeof window !== "undefined"
    ? `${window.location.origin}/api/line/webhook/${platform.code}`
    : `https://your-domain/api/line/webhook/${platform.code}`;

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, string | null> = clearAll
        ? { channel_token: "", channel_secret: "" }
        : {};
      if (!clearAll) {
        if (token.trim()) body.channel_token = token.trim();
        if (secret.trim()) body.channel_secret = secret.trim();
      }
      if (Object.keys(body).length === 0) {
        setMsg({ kind: "err", text: t(lang, "admin.messaging.err.noChange") });
        setBusy(false);
        return;
      }
      const res = await fetch(apiUrl("/api/admin/messaging/platform"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
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

  const isReady = platform.has_token && platform.has_secret;

  return (
    <div className="space-y-4">
      {/* Platform channel: IKIGAI OS */}
      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-slate-800">
                {t(lang, "admin.messaging.platformTitle")}
              </h2>
              <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                isReady ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
              }`}>
                {isReady
                  ? t(lang, "admin.messaging.statusReady")
                  : t(lang, "admin.messaging.statusNotConfigured")}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {t(lang, "admin.messaging.platformDesc")}
            </p>
          </div>
        </div>

        {/* Webhook URL — read-only with copy button */}
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
          <p className="text-xs text-slate-500 mt-1">
            {t(lang, "admin.messaging.webhookHint")}
          </p>
        </div>

        {/* Channel access token */}
        <div>
          <label className="label">
            {t(lang, "admin.messaging.token")}
            {platform.has_token && (
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
            placeholder={platform.has_token
              ? t(lang, "admin.messaging.tokenPlaceholderKeep")
              : t(lang, "admin.messaging.tokenPlaceholder")}
            disabled={clearAll}
          />
        </div>

        {/* Channel secret */}
        <div>
          <label className="label">
            {t(lang, "admin.messaging.secret")}
            {platform.has_secret && (
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
            placeholder={platform.has_secret
              ? t(lang, "admin.messaging.secretPlaceholderKeep")
              : t(lang, "admin.messaging.secretPlaceholder")}
            disabled={clearAll}
          />
          <p className="text-xs text-slate-500 mt-1">
            {t(lang, "admin.messaging.credsHint")}
          </p>
        </div>

        {/* Clear toggle */}
        {(platform.has_token || platform.has_secret) && (
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <Switch
              checked={clearAll}
              accent="rose"
              onChange={(v) => {
                setClearAll(v);
                if (v) { setToken(""); setSecret(""); }
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

      {/* RESERVA per-branch hint */}
      <div className="card border-l-4 border-sky-300 bg-sky-50/40">
        <h2 className="font-semibold text-slate-800">
          {t(lang, "admin.messaging.reservaTitle")}
        </h2>
        <p className="text-xs text-slate-600 mt-1">
          {t(lang, "admin.messaging.reservaDesc")}
        </p>
      </div>

      {/* Setup steps */}
      <div className="card text-sm text-slate-700 space-y-2">
        <h3 className="font-semibold text-slate-800">
          {t(lang, "admin.messaging.howto.title")}
        </h3>
        <ol className="list-decimal pl-5 space-y-1 text-xs leading-relaxed">
          <li>{t(lang, "admin.messaging.howto.step1")}</li>
          <li>{t(lang, "admin.messaging.howto.step2")}</li>
          <li>{t(lang, "admin.messaging.howto.step3")}</li>
          <li>{t(lang, "admin.messaging.howto.step4")}</li>
          <li>{t(lang, "admin.messaging.howto.step5")}</li>
        </ol>
      </div>
    </div>
  );
}
