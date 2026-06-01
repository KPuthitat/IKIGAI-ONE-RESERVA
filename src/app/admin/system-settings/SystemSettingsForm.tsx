"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import Switch from "@/app/components/Switch";

// Client form for editing GLOBAL system settings — IKIGAI OS LINE OA
// credentials + the cross-branch staff group ID.
//
// UX considerations:
//   • token is treated as a secret — we ship the placeholder "•••• set"
//     when one exists rather than the raw value, and require the admin
//     to retype to change. Avoids accidental exposure if someone
//     screenshots the page. Empty submission = unchanged.
//   • group ID is shown as-is since it's not sensitive (it's a chat
//     room identifier, not a credential).
//   • "Reveal token" toggle for the rare case where admin needs to
//     check the current value — uses a separate API call (not yet
//     wired; placeholder for future). For now admin re-pastes from
//     LINE Developers console when rotating.

export default function SystemSettingsForm({
  token,
  groupId,
  defaultEscalationHours,
  maintenanceMessage,
  maintenanceActive,
  privacyPolicyUrl,
  recruitaExecGroupId
}: {
  token: string | null;
  groupId: string | null;
  defaultEscalationHours: number;
  maintenanceMessage: string;
  maintenanceActive: boolean;
  privacyPolicyUrl: string;
  recruitaExecGroupId: string;
}) {
  const router = useRouter();
  const { t } = useLang();

  // Sentinel — when token exists on the server we show "•••• set" in
  // the field. Admin typing anything else triggers an update; empty
  // submit = leave unchanged.
  const TOKEN_PLACEHOLDER = token ? "•••••••• " + t("admin.systemSettings.tokenIsSet") : "";

  const [tokenInput, setTokenInput] = useState("");
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [groupInput, setGroupInput] = useState(groupId ?? "");
  // System-wide escalation window for leave / resignation approvals.
  // Used when an approver doesn't decide within this many hours —
  // the cron sweep reassigns to their manager. Previously was a
  // per-user field on the employee form; consolidated here 2026-05.
  const [escHoursInput, setEscHoursInput] = useState(String(defaultEscalationHours));
  // Maintenance banner (2026-05-28). Two-state model so the owner
  // authors the message ONCE then just toggles on/off:
  //   maintenanceInput — template text (persisted always)
  //   maintenanceOn    — toggle (banner renders iff ON + non-empty)
  const [maintenanceInput, setMaintenanceInput] = useState(maintenanceMessage);
  const [maintenanceOn, setMaintenanceOn] = useState<boolean>(maintenanceActive);
  // Privacy policy URL (2026-06-01) — single source of truth used by
  // every PDPA consent surface. Owner pastes the Canva published-link
  // (or any public URL) once; consent banners render a "ดูนโยบาย"
  // button linking to it.
  const [policyUrlInput, setPolicyUrlInput] = useState(privacyPolicyUrl);
  // RECRUITA executive group — receives "new application" Flex pushes.
  // Separate from global_staff_group_id so admin can route hiring
  // notifications to the owners chat without the staff seeing them.
  const [recruitaExecInput, setRecruitaExecInput] = useState(recruitaExecGroupId);
  // (Resignation-policy textareas moved 2026-05-28 to
  // /admin/persona/resignation — that's the menu where admins
  // already manage resignation requests, so the policy authoring
  // lives next to its consumer.)
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const body: Record<string, string> = {};
      // Only include token in the patch if admin typed something —
      // empty input = "keep current token unchanged".
      if (tokenInput.trim()) {
        body.global_line_channel_token = tokenInput.trim();
      }
      // Group ID is always sent (empty string = clear).
      body.global_staff_group_id = groupInput.trim();

      // Escalation window — always sent. Client clamps to 1–720h
      // (1 hour to 30 days) so a typo doesn't disable escalation
      // by sending 0; server validates as well.
      const escH = Math.max(1, Math.min(720, parseInt(escHoursInput, 10) || 24));
      body.default_escalation_hours = String(escH);

      // Maintenance banner — both fields always sent. Server stores
      // them independently so toggling doesn't wipe the template.
      body.maintenance_message = maintenanceInput;
      body.maintenance_active = maintenanceOn ? "true" : "false";

      // Always send — empty string clears the value server-side.
      body.privacy_policy_url = policyUrlInput.trim();
      body.recruita_exec_group_id = recruitaExecInput.trim();

      // (Resignation-policy fields moved to /admin/persona/resignation
      // 2026-05-28 — this form no longer sends them.)

      const res = await fetch(apiUrl("/api/admin/system-settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({
          kind: "err",
          text: j.message || j.error || t("common.error")
        });
        return;
      }
      setMsg({ kind: "ok", text: t("admin.systemSettings.saved") });
      setTokenInput("");
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {/* IKIGAI OS LINE OA section */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            {t("admin.systemSettings.lineOa.title")}
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {t("admin.systemSettings.lineOa.help")}
          </p>
        </div>

        <div>
          <label className="label">
            {t("admin.systemSettings.lineOa.tokenLabel")}
          </label>
          <input
            type={tokenRevealed ? "text" : "password"}
            className="input text-xs"
            placeholder={TOKEN_PLACEHOLDER || t("admin.systemSettings.lineOa.tokenPlaceholder")}
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            autoComplete="off"
          />
          <div className="flex justify-between items-center mt-1">
            <p className="text-[10px] text-slate-400">
              {token
                ? t("admin.systemSettings.lineOa.tokenHintSet")
                : t("admin.systemSettings.lineOa.tokenHintEmpty")}
            </p>
            <button
              type="button"
              onClick={() => setTokenRevealed(!tokenRevealed)}
              className="text-[10px] text-slate-500 hover:text-brand"
            >
              {tokenRevealed
                ? t("admin.systemSettings.lineOa.tokenHide")
                : t("admin.systemSettings.lineOa.tokenShow")}
            </button>
          </div>
        </div>

        <div>
          <label className="label">
            {t("admin.systemSettings.lineOa.groupIdLabel")}
          </label>
          <input
            type="text"
            className="input text-xs"
            placeholder="Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            value={groupInput}
            onChange={(e) => setGroupInput(e.target.value)}
            autoComplete="off"
            maxLength={100}
          />
          <p className="text-[10px] text-slate-400 mt-1">
            {t("admin.systemSettings.lineOa.groupIdHint")}
          </p>
        </div>
      </div>

      {/* Approval escalation — system-wide default window */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            {t("admin.systemSettings.escalation.title")}
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {t("admin.systemSettings.escalation.help")}
          </p>
        </div>
        <div>
          <label className="label">
            {t("admin.systemSettings.escalation.hoursLabel")}
          </label>
          <input
            type="number"
            className="input"
            value={escHoursInput}
            onChange={(e) => setEscHoursInput(e.target.value)}
            min={1}
            max={720}
            step={1}
            inputMode="numeric"
          />
          <p className="text-[10px] text-slate-400 mt-1">
            {t("admin.systemSettings.escalation.hoursHint")}
          </p>
        </div>
      </div>

      {/* Resignation-policy textareas (improper consequences +
          unlock LINE body) moved 2026-05-28 to /admin/persona/
          resignation. They were sitting here only because the DB
          columns live on system_settings, but admins author them as
          part of HR policy + manage the requests right next door —
          asking them to bounce to system-settings was friction. */}

      {/* Maintenance banner — toggle + persistent template */}
      <div className="card space-y-4">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            🛠️ แบนเนอร์ + หน้า Maintenance
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            ข้อความเดียวกันใช้ใน <strong>2 ที่</strong>:
            <br />
            <span className="ml-3">• <strong>แบนเนอร์สีฟ้าบนหัวทุกหน้า</strong> — เปิด/ปิดด้วย toggle ด้านล่าง (ใช้เตือนก่อน/หลัง deploy)</span>
            <br />
            <span className="ml-3">• <strong>หน้า Maintenance เต็มจอ</strong> — ขึ้นอัตโนมัติเมื่อ Next.js ตาย (ระหว่าง deploy / crash) — Nginx จัดการเอง</span>
            <br />
            <a href="/api/maintenance/preview" target="_blank" rel="noopener noreferrer"
               className="inline-flex items-center gap-1 mt-2 text-brand hover:underline font-medium">
              เปิดดูตัวอย่างหน้า Maintenance ในแท็บใหม่ →
            </a>
          </p>
        </div>

        {/* Toggle — primary control. Big, friendly, accent green when
            ON so the page screams "banner is currently live!" at a
            glance. */}
        <div className={`rounded-xl border-2 p-3 transition ${
          maintenanceOn
            ? "border-sky-400 bg-sky-50"
            : "border-slate-200 bg-slate-50"
        }`}>
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-bold ${
                maintenanceOn ? "text-sky-800" : "text-slate-700"
              }`}>
                {maintenanceOn
                  ? "🟢 แบนเนอร์เปิดอยู่ตอนนี้ — พนักงานเห็นข้อความบนหัวทุกหน้า"
                  : "⚪ แบนเนอร์ปิด — พนักงานไม่เห็นอะไร"}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {maintenanceInput.trim()
                  ? "กดสวิตช์เพื่อสลับเปิด/ปิด · ข้อความเก็บไว้ตลอด"
                  : "⚠️ ต้องพิมพ์ข้อความด้านล่างก่อน ถึงเปิดแล้วถึงจะมีอะไรแสดง"}
              </div>
            </div>
            <Switch
              checked={maintenanceOn}
              onChange={setMaintenanceOn}
              accent="sky"
            />
          </label>
        </div>

        {/* Template text — usually authored once + reused. The toggle
            above does the day-to-day on/off. */}
        <div>
          <label className="label">ข้อความที่จะแสดง (template)</label>
          <textarea
            className="input text-sm"
            rows={3}
            maxLength={500}
            value={maintenanceInput}
            onChange={(e) => setMaintenanceInput(e.target.value)}
            placeholder="ตัวอย่าง: ระบบกำลังอัพเดท ใช้งานได้ตามปกติ ถ้าเจอ error ขอให้รอ 1-2 นาทีแล้วลองใหม่ครับ"
          />
          <p className="text-[10px] text-slate-400 text-right">
            {maintenanceInput.length} / 500
          </p>
        </div>

        {/* Live preview — only when there's actually a message. */}
        {maintenanceInput.trim() && (
          <div>
            <div className="text-[10px] uppercase tracking-[0.5px] font-bold text-slate-500 mb-1.5">
              พรีวิว {maintenanceOn ? "(ตอนนี้พนักงานเห็นแบบนี้)" : "(ตอนนี้ยังไม่แสดง — เปิดสวิตช์ด้านบนก่อน)"}
            </div>
            <div className={`rounded-lg overflow-hidden border shadow-sm ${
              maintenanceOn ? "border-sky-300" : "border-slate-200 opacity-60"
            }`}>
              <div className="bg-sky-600 text-white px-3 py-2 flex items-center gap-3 text-xs sm:text-sm">
                <span className="text-base flex-shrink-0">🛠️</span>
                <div className="flex-1 min-w-0 whitespace-pre-line">
                  {maintenanceInput.trim()}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* PDPA / Privacy policy — single URL pasted once, reused by
          every consent surface (recruita apply, booking, walk-in,
          etc.). Owner authors the policy in Canva / Google Docs;
          we just link to it. */}
      <div className="card space-y-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">
            นโยบายความเป็นส่วนตัว (PDPA)
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            URL ของหน้านโยบายที่จะแสดงให้ผู้ใช้กดดูบนทุกฟอร์มขอ consent
          </p>
        </div>
        <div>
          <label className="label">URL นโยบาย</label>
          <input
            className="input text-sm font-mono"
            type="url"
            value={policyUrlInput}
            onChange={(e) => setPolicyUrlInput(e.target.value)}
            placeholder="https://www.canva.com/design/..."
            maxLength={500} />
          <p className="text-[10px] text-slate-400 mt-1">
            ปล่อยว่าง = ไม่แสดงปุ่ม &quot;ดูนโยบาย&quot; (เหมือนเดิม).
            ใช้ลิงก์ Canva published-link, Google Doc public, หรือ URL บนเว็บบริษัทก็ได้
          </p>
        </div>
      </div>

      {/* RECRUITA exec group — receives new-application Flex pushes */}
      <div className="card space-y-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">
            RECRUITA · กลุ่ม LINE ผู้บริหาร
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            กลุ่มที่จะได้รับแจ้งเตือนทันที เมื่อมีใบสมัครงานใหม่เข้ามา
            (ส่งผ่าน IKIGAI OS OA)
          </p>
        </div>
        <div>
          <label className="label">LINE Group ID</label>
          <input
            className="input text-sm font-mono"
            type="text"
            value={recruitaExecInput}
            onChange={(e) => setRecruitaExecInput(e.target.value)}
            placeholder="Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            maxLength={100} />
          <p className="text-[10px] text-slate-400 mt-1">
            ขึ้นต้นด้วย C/R/U ตามด้วย 32 hex characters.
            ปล่อยว่าง = ไม่ส่งแจ้งเตือน. แยกจาก IKIGAI OS staff group ด้านบน
          </p>
        </div>
      </div>

      {/* Routing status — informational summary */}
      <div className="card text-xs space-y-1.5 bg-slate-50 border-slate-200">
        <div className="font-bold text-slate-600 uppercase tracking-[0.5px] text-[10px]">
          {t("admin.systemSettings.routingStatus.title")}
        </div>
        <RoutingRow
          label={t("admin.systemSettings.routingStatus.persona")}
          active={!!(token && groupId)}
          activeLabel={t("admin.systemSettings.routingStatus.viaGlobal")}
          inactiveLabel={t("admin.systemSettings.routingStatus.viaBranch")}
        />
        <RoutingRow
          label={t("admin.systemSettings.routingStatus.bookings")}
          active={false}
          activeLabel={t("admin.systemSettings.routingStatus.viaGlobal")}
          inactiveLabel={t("admin.systemSettings.routingStatus.alwaysBranch")}
        />
      </div>

      {msg && (
        <div className={`text-sm text-center ${
          msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
        }`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}
          {msg.text}
        </div>
      )}

      <button
        type="submit"
        disabled={busy}
        className="btn-primary w-full text-base py-3.5"
      >
        {busy ? t("common.submitting") : t("common.save")}
      </button>
    </form>
  );
}

// Small status row showing where each notification type currently
// routes. Helps admin visualise the effect of toggling the global
// OA before staff start asking "why didn't I get the message?".
function RoutingRow({
  label,
  active,
  activeLabel,
  inactiveLabel
}: {
  label: string;
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
}) {
  return (
    <div className="flex justify-between items-center gap-2">
      <span className="text-slate-700">{label}</span>
      <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
        active
          ? "bg-emerald-100 text-emerald-700"
          : "bg-slate-200 text-slate-600"
      }`}>
        {active ? activeLabel : inactiveLabel}
      </span>
    </div>
  );
}
