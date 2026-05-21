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
  lang, platform, globalStaffGroupId = "", isSuperAdmin = false
}: {
  lang: Lang;
  platform: PlatformChannelInitial;
  globalStaffGroupId?: string;
  isSuperAdmin?: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [clearAll, setClearAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Cross-branch staff group ID for PERSONA notifications. Only the
  // super_admin sees / can change this — see the page guard.
  const [groupId, setGroupId] = useState(globalStaffGroupId);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupMsg, setGroupMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // LINE test-push diagnostic state. The "ทดสอบส่งข้อความ" button
  // calls /api/admin/messaging/test-push which exercises the same
  // credentials the auto-flow uses. The response is shown verbatim so
  // admin can see the real LINE API error (or a friendlier Thai
  // explanation pre-baked on the server).
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{
    kind: "ok" | "err";
    message: string;
    lineStatus?: number | null;
    lineBody?: string | null;
    status?: Record<string, unknown> | null;
  } | null>(null);

  async function runTestPush(): Promise<void> {
    setTestBusy(true);
    setTestResult(null);
    try {
      const res = await fetch(apiUrl("/api/admin/messaging/test-push"), {
        method: "POST"
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        setTestResult({
          kind: "ok",
          message: t(lang, "admin.messaging.test.ok"),
          status: j.status ?? null
        });
      } else {
        setTestResult({
          kind: "err",
          message: j?.message ?? j?.error ?? t(lang, "common.error"),
          lineStatus: j?.line_status ?? null,
          lineBody: j?.line_body ?? null,
          status: j?.status ?? null
        });
      }
    } catch (e) {
      setTestResult({
        kind: "err",
        message: e instanceof Error ? e.message : t(lang, "common.error")
      });
    } finally {
      setTestBusy(false);
    }
  }

  async function saveGroupId(): Promise<void> {
    setGroupBusy(true);
    setGroupMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/system-settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ global_staff_group_id: groupId.trim() })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setGroupMsg({
          kind: "err",
          text: j?.message || j?.error || t(lang, "common.error")
        });
        return;
      }
      setGroupMsg({ kind: "ok", text: t(lang, "common.saved") });
      startTransition(() => router.refresh());
    } catch {
      setGroupMsg({ kind: "err", text: t(lang, "common.error") });
    } finally {
      setGroupBusy(false);
    }
  }

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

      {/* ── Cross-branch staff group ── super_admin only.
          PERSONA notifications (daily reports, edit requests,
          readiness summaries, decisions) are pushed via the IKIGAI
          OS OA to this one group, regardless of which branch a
          checklist or report came from. Per-branch checklist content
          stays different; the destination group does not. */}
      {isSuperAdmin && (
        <div className="card space-y-3">
          <div>
            <h2 className="font-semibold text-slate-800">
              {t(lang, "admin.systemSettings.lineOa.groupIdLabel")}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              {t(lang, "admin.systemSettings.lineOa.groupIdHint")}
            </p>
          </div>
          <input
            type="text"
            className="input text-xs"
            placeholder="Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value.trim())}
            autoComplete="off"
            maxLength={100}
          />
          <ol className="text-[11px] text-slate-500 space-y-0.5 leading-snug list-decimal pl-4">
            <li>เปิด LINE OA Manager → Settings → Chat → เปิด "Allow group chats"</li>
            <li>เชิญ OA "IKIGAI OS PORTAL" เข้ากลุ่มพนักงานรวม</li>
            <li>บอทจะโพสต์ Group ID (ขึ้นต้นด้วย C…) เข้ากลุ่มอัตโนมัติ — คัดลอกมาวางช่องด้านบน</li>
            <li>บันทึก → ทุกแจ้งเตือน PERSONA ของทุกสาขาจะมาเข้ากลุ่มเดียวกันนี้</li>
          </ol>
          <div className="flex items-center justify-between gap-3 pt-1">
            {groupMsg && (
              <span className={`text-sm ${groupMsg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
                {groupMsg.kind === "ok" ? "✓ " : "✗ "}{groupMsg.text}
              </span>
            )}
            <button type="button" onClick={saveGroupId} disabled={groupBusy}
              className="btn-primary text-sm ml-auto">
              {groupBusy ? t(lang, "common.submitting") : t(lang, "common.save")}
            </button>
          </div>
        </div>
      )}

      {/* Diagnostic: actually push a test message via the same path
          the auto-flow uses. The 502 response body carries the real
          LINE API error so admin can fix the root cause (wrong token /
          OA-not-in-group / wrong group id) instead of guessing. */}
      <div className="card space-y-3 border-l-4 border-sky-300 bg-sky-50/40">
        <div>
          <h2 className="font-semibold text-slate-800">
            {t(lang, "admin.messaging.test.title")}
          </h2>
          <p className="text-xs text-slate-600 mt-1">
            {t(lang, "admin.messaging.test.hint")}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={runTestPush}
            disabled={testBusy}
            className="btn-primary text-sm"
          >
            {testBusy ? t(lang, "common.submitting") : t(lang, "admin.messaging.test.btn")}
          </button>
          {testResult && (
            <span
              className={`text-sm ${
                testResult.kind === "ok" ? "text-emerald-700" : "text-rose-600"
              }`}
            >
              {testResult.kind === "ok" ? "✓ " : "✗ "}{testResult.message}
            </span>
          )}
        </div>
        {/* Detailed diagnosis — only on failure. Shows which credentials
            are present + the raw LINE API response so admin can debug
            without SSH-ing to read server logs. */}
        {testResult && testResult.kind === "err" && testResult.status && (
          <div className="text-[11px] bg-white border border-rose-200 rounded-md p-2.5 space-y-1 font-mono">
            <div className="text-rose-700 font-bold">
              {t(lang, "admin.messaging.test.diagnosis")}
            </div>
            <div>
              Platform token: {(testResult.status as Record<string, unknown>).has_platform_token ? "✓ ตั้งแล้ว" : "✗ ยังไม่ได้ตั้ง"}
            </div>
            <div>
              Legacy token: {(testResult.status as Record<string, unknown>).has_legacy_token ? "✓ ตั้งแล้ว" : "✗ ยังไม่ได้ตั้ง"}
            </div>
            <div>
              Group ID: {(testResult.status as Record<string, unknown>).has_group_id
                ? `✓ ${(testResult.status as Record<string, unknown>).group_id_preview} (${(testResult.status as Record<string, unknown>).group_id_looks_valid ? "รูปแบบถูก" : "รูปแบบผิด"})`
                : "✗ ยังไม่ได้ตั้ง"}
            </div>
            {testResult.lineStatus != null && (
              <div className="pt-1 border-t border-rose-100">
                LINE API HTTP {testResult.lineStatus}
              </div>
            )}
            {testResult.lineBody && (
              <div className="text-rose-600 break-all">
                {testResult.lineBody}
              </div>
            )}
          </div>
        )}
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
