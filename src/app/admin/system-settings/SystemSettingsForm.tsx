"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

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
  improperResignationConsequences,
  resignationUnlockMessage
}: {
  token: string | null;
  groupId: string | null;
  defaultEscalationHours: number;
  improperResignationConsequences: string;
  resignationUnlockMessage: string;
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
  // Free-text policy for improper resignation. Owner sets once,
  // shown on both staff resignation form + admin decide modal.
  const [improperText, setImproperText] = useState(improperResignationConsequences);
  // LINE Flex body for the unlock notification. {ADMIN} placeholder
  // is replaced at send time with the operator's display_name.
  const [unlockMsg, setUnlockMsg] = useState(resignationUnlockMessage);
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

      // Improper-resignation consequences (free text). Always sent —
      // empty string = "clear it" so the staff form omits the warning
      // block. Server trims + nullifies an empty value.
      body.improper_resignation_consequences = improperText;
      // Resignation-unlock LINE body. Empty = fall back to default.
      body.resignation_unlock_message = unlockMsg;

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

      {/* Improper-resignation policy text (2026-05-27).
          Owner writes once; shown on staff resignation form +
          beside admin's forfeit-SVC checkbox on approval. */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            หมายเหตุ — ลาออกไม่ถูกระเบียบจะเสียสิทธิ์อะไรบ้าง
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            ข้อความนี้จะแสดงในแบบฟอร์มลาออกของพนักงาน + ตอนแอดมินพิจารณา ติ๊ก
            &quot;ลาออกไม่ถูกระเบียบ&quot; เพื่อให้ทั้งสองฝ่ายเห็นกติกาตรงกัน
            เว้นว่าง = ไม่แสดง
          </p>
        </div>
        <textarea
          className="input"
          rows={5}
          maxLength={2000}
          value={improperText}
          onChange={(e) => setImproperText(e.target.value)}
          placeholder="เช่น&#10;· เสียสิทธิ์รับเงินส่วนแบ่ง Service Charge เดือนสุดท้าย&#10;· ไม่ได้รับโบนัสปลายปี&#10;· อาจต้องชดใช้เงินค่าฝึกอบรมตามที่ระบุในสัญญา"
        />
        <p className="text-[10px] text-slate-400 text-right">
          {improperText.length} / 2000
        </p>
      </div>

      {/* Resignation-unlock LINE message (2026-05-27).
          Body text of the card sent to a staff when admin opens
          their สิทธิ์ยื่นลาออก. Empty = built-in default fires. */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            ข้อความแจ้งเตือน — เมื่อแอดมินเปิดสิทธิ์ลาออก
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            ข้อความนี้จะส่งทาง LINE หาพนักงาน เมื่อแอดมินกด &quot;เปิดสิทธิ์ลาออก&quot; ที่หน้า{" "}
            <code className="text-[10px] bg-slate-100 px-1 rounded">/admin/persona/resignation</code> ·
            ใช้ <code className="text-[10px] bg-slate-100 px-1 rounded">{"{ADMIN}"}</code> แทนชื่อแอดมินที่กดเปิด · เว้นว่าง = ใช้ข้อความเริ่มต้นของระบบ
          </p>
        </div>
        <textarea
          className="input"
          rows={4}
          maxLength={1000}
          value={unlockMsg}
          onChange={(e) => setUnlockMsg(e.target.value)}
          placeholder="{ADMIN} เพิ่งเปิดสิทธิ์ยื่นใบลาออกให้พี่แล้วครับ — ถ้าพี่ต้องการยื่น สามารถเข้าไปกรอกแบบฟอร์มได้ที่ปุ่มด้านล่าง"
        />
        <p className="text-[10px] text-slate-400 text-right">
          {unlockMsg.length} / 1000
        </p>
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
