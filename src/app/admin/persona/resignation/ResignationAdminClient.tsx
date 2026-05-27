"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import type { ResignationStatus } from "@/app/staff/persona/resignation/ResignationClient";
import { DecisionModal } from "@/app/admin/persona/leave/LeaveAdminClient";
import { useConfirm } from "@/app/components/useConfirm";
import { nameWithPrefix } from "@/lib/name";

export type ResignationAdminRow = {
  id: number;
  user_id: number;
  proposed_last_day: string;
  computed_min_last_day: string;
  reason: string;
  evidence_filename: string | null;
  is_special_request: number;
  status: ResignationStatus;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  username: string;
  display_name: string;
  title_prefix: string | null;
  hire_date: string | null;
  decided_by_name: string | null;
  decided_by_prefix: string | null;
  ref_no?: string | null;
};

export type StaffUnlockOption = {
  id: number;
  username: string;
  display_name: string;
  title_prefix: string | null;
  resignation_unlocked_at: string | null;
  unlocked_by_name: string | null;
};

type StatusFilter = "pending" | "approved" | "rejected" | "cancelled" | "all";
const FILTERS: StatusFilter[] = ["pending", "approved", "rejected", "cancelled", "all"];

export default function ResignationAdminClient({
  currentStatus,
  countMap,
  requests,
  staffList,
  improperResignationConsequences,
  resignationUnlockMessage
}: {
  currentStatus: StatusFilter;
  countMap: Record<string, number>;
  requests: ResignationAdminRow[];
  staffList: StaffUnlockOption[];
  /** Owner-authored "ลาออกไม่ถูกระเบียบเสียสิทธิ์อะไรบ้าง" text from
   *  system_settings — passed straight through to DecisionModal so
   *  admin sees the policy when ticking the forfeit-SVC switch. */
  improperResignationConsequences: string | null;
  /** LINE body fired when admin opens a staff's resignation gate.
   *  Editable inline at the top of this page. */
  resignationUnlockMessage: string | null;
}) {
  const router = useRouter();
  const { t, formatDate } = useLang();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [unlockUserId, setUnlockUserId] = useState<number | "">(staffList[0]?.id ?? "");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const { confirm, alert, ConfirmDialog } = useConfirm();

  const unlockedUsers = staffList.filter((u) => u.resignation_unlocked_at);

  async function toggleUnlock(userId: number, action: "unlock" | "lock") {
    if (action === "lock") {
      const ok = await confirm({
        title: t("admin.persona.resignation.confirmLockTitle"),
        body: <p>{t("admin.persona.resignation.confirmLock")}</p>,
        confirmLabel: t("common.confirm"),
        cancelLabel: t("common.cancel"),
        variant: "warning"
      });
      if (ok === null) return;
    }
    setUnlockBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/resignation/unlock"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, action })
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) startTransition(() => router.refresh());
      else alert({
        title: t("common.error"),
        body: <p>{data.error ?? t("common.error")}</p>,
        variant: "danger",
        okLabel: t("common.confirm")
      });
    } finally {
      setUnlockBusy(false);
    }
  }

  type DecideTarget = { id: number; decision: "approved" | "rejected" | "revision_requested" };
  const [decideTarget, setDecideTarget] = useState<DecideTarget | null>(null);
  const [decideNote, setDecideNote] = useState("");
  // forfeitSvc — admin's per-decision choice when approving a
  // resignation. true = staff loses this month's SVC accrual to the
  // company. Defaults to false so the safe path is "keep paying".
  const [forfeitSvc, setForfeitSvc] = useState(false);

  function decide(id: number, decision: DecideTarget["decision"]) {
    setDecideTarget({ id, decision });
    setDecideNote("");
    setForfeitSvc(false);
  }

  async function confirmDecide() {
    if (!decideTarget) return;
    const { id, decision } = decideTarget;
    if (decision === "revision_requested" && !decideNote.trim()) {
      alert({
        title: t("common.error"),
        body: <p>{t("admin.persona.resignation.revisionNoteRequired")}</p>,
        variant: "warning",
        okLabel: t("common.confirm")
      });
      return;
    }
    setBusyId(id);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/resignation/${id}/decide`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          note: decideNote.trim() || undefined,
          // forfeit_svc is meaningful only when approving — the API
          // ignores it for reject/revision, but sending it here keeps
          // the contract symmetric.
          forfeit_svc: decision === "approved" ? forfeitSvc : false
        })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        setDecideTarget(null);
        startTransition(() => router.refresh());
      } else {
        alert({
          title: t("common.error"),
          body: <p>{j?.error ?? t("common.error")}</p>,
          variant: "danger",
          okLabel: t("common.confirm")
        });
      }
    } catch {
      alert({
        title: t("common.error"),
        body: <p>{t("common.error")}</p>,
        variant: "danger",
        okLabel: t("common.confirm")
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {/* Improper-resignation policy editor — kept inline because
          this is where admins reach for it when reviewing a request.
          The LINE unlock-card customizer moved to
          /admin/persona/notifications (single hub for all card text
          editors with previews); a link to it sits at the top of the
          PolicyEditor's expanded view so admin doesn't lose track. */}
      <PolicyEditor
        initialImproper={improperResignationConsequences ?? ""}
      />

      {/* Unlock card — admin เปิดสิทธิ์ลาออกให้พนักงาน */}
      <div className="card border-l-4 border-amber-400 bg-amber-50">
        <h2 className="font-semibold text-slate-800 mb-2">
          {t("admin.persona.resignation.unlockTitle")}
        </h2>
        <p className="text-sm text-slate-600 mb-3">
          {t("admin.persona.resignation.unlockDescription")}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[200px]">
            <label className="label">{t("admin.persona.leave.staff")}</label>
            <select
              className="input"
              value={unlockUserId}
              onChange={(e) => setUnlockUserId(Number(e.target.value))}
            >
              {staffList.map((u) => (
                <option key={u.id} value={u.id}>
                  {nameWithPrefix(u.title_prefix, u.display_name)} (@{u.username})
                  {u.resignation_unlocked_at ? ` — ${t("admin.persona.resignation.alreadyUnlocked")}` : ""}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={!unlockUserId || unlockBusy}
            onClick={() => unlockUserId && toggleUnlock(Number(unlockUserId), "unlock")}
            className="btn-primary"
          >
            {t("admin.persona.resignation.unlockButton")}
          </button>
        </div>

        {unlockedUsers.length > 0 && (
          <div className="mt-4 pt-3 border-t border-amber-300">
            <p className="text-xs font-medium text-slate-600 mb-2">
              {t("admin.persona.resignation.currentlyUnlocked")} ({unlockedUsers.length})
            </p>
            <ul className="space-y-1.5">
              {unlockedUsers.map((u) => (
                <li key={u.id} className="flex items-center justify-between text-sm bg-white rounded px-3 py-1.5 border border-amber-200">
                  <span>
                    <span className="font-medium">{nameWithPrefix(u.title_prefix, u.display_name)}</span>
                    <span className="text-xs text-slate-400 ml-1">@{u.username}</span>
                    {u.resignation_unlocked_at && (
                      <span className="text-xs text-slate-500 ml-2">
                        {formatDate(u.resignation_unlocked_at.slice(0, 10))}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    disabled={unlockBusy}
                    onClick={() => toggleUnlock(u.id, "lock")}
                    className="text-xs text-rose-600 hover:underline"
                  >
                    {t("admin.persona.resignation.lockButton")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="card flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const active = currentStatus === f;
          const n = f === "all"
            ? Object.values(countMap).reduce((a, b) => a + b, 0)
            : (countMap[f] ?? 0);
          return (
            <Link
              key={f}
              href={`/admin/persona/resignation?status=${f}`}
              className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                active
                  ? "bg-brand text-white border-brand"
                  : "bg-white text-slate-700 border-slate-200 hover:border-brand"
              }`}
            >
              {t(`admin.persona.leave.filter.${f}` as any)}
              <span className={`ml-1.5 text-xs ${active ? "text-white/80" : "text-slate-400"}`}>
                {n}
              </span>
            </Link>
          );
        })}
      </div>

      <div className="card">
        <h2 className="font-semibold text-slate-800 mb-3">
          {t("admin.persona.resignation.listTitle")} ({requests.length})
        </h2>
        {requests.length === 0 ? (
          <p className="text-slate-500 text-sm py-6 text-center">
            {t("admin.persona.resignation.empty")}
          </p>
        ) : (
          <ul className="space-y-3">
            {requests.map((r) => {
              const earlier = r.proposed_last_day < r.computed_min_last_day;
              return (
                <li key={r.id} className="border border-slate-200 rounded-lg p-3 hover:bg-slate-50 transition">
                  <div className="flex flex-wrap justify-between items-start gap-2 mb-1">
                    <div className="flex-1 min-w-[200px]">
                      {r.ref_no && (
                        <div className="text-xs text-slate-400 font-mono mb-0.5">#{r.ref_no}</div>
                      )}
                      <div className="font-medium text-slate-800">
                        {nameWithPrefix(r.title_prefix, r.display_name)}
                        <span className="text-xs text-slate-400 ml-1.5">@{r.username}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <span className="text-sm font-medium text-slate-700">
                          {t("admin.persona.resignation.lastDayLabel")}: {formatDate(r.proposed_last_day)}
                        </span>
                        {r.is_special_request === 1 && (
                          <span className="text-xs px-2 py-0.5 rounded font-medium bg-violet-100 text-violet-700 border border-violet-300">
                            {t("admin.persona.leave.specialBadge")}
                          </span>
                        )}
                        {earlier && (
                          <span className="text-xs px-2 py-0.5 rounded font-medium bg-rose-100 text-rose-700">
                            {t("admin.persona.resignation.earlierBadge")}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        {t("admin.persona.resignation.minLastDayInfo", {
                          minLastDay: formatDate(r.computed_min_last_day)
                        })}
                      </div>
                      {r.hire_date && (
                        <div className="text-xs text-slate-500">
                          {t("admin.persona.resignation.hireDate")}: {formatDate(r.hire_date)}
                        </div>
                      )}
                      <div className="text-xs text-slate-500 mt-1.5 italic">"{r.reason}"</div>
                      {r.evidence_filename && (
                        <a
                          href={apiUrl(`/api/persona/resignation/${r.id}/attachment`)}
                          target="_blank" rel="noopener"
                          className="inline-block text-xs text-brand hover:underline mt-1"
                        >
                          {t("staff.persona.leave.viewEvidence")}
                        </a>
                      )}
                      {r.decision_note && r.decided_by_name && (
                        <div className="text-xs text-slate-600 mt-1.5 bg-slate-100 px-2 py-1 rounded">
                          <span className="font-medium">{nameWithPrefix(r.decided_by_prefix, r.decided_by_name)}:</span> {r.decision_note}
                        </div>
                      )}
                    </div>
                    {r.status === "pending" && (
                      <div className="flex gap-1.5 flex-wrap">
                        <button
                          type="button"
                          disabled={pending || busyId === r.id}
                          onClick={() => decide(r.id, "approved")}
                          className="px-3 py-1.5 rounded text-xs font-medium bg-emerald-500 hover:bg-emerald-600 text-white disabled:opacity-50"
                        >
                          {t("admin.persona.leave.approve")}
                        </button>
                        <button
                          type="button"
                          disabled={pending || busyId === r.id}
                          onClick={() => decide(r.id, "revision_requested")}
                          className="px-3 py-1.5 rounded text-xs font-medium bg-orange-500 hover:bg-orange-600 text-white disabled:opacity-50"
                        >
                          {t("admin.persona.leave.requestRevision")}
                        </button>
                        <button
                          type="button"
                          disabled={pending || busyId === r.id}
                          onClick={() => decide(r.id, "rejected")}
                          className="px-3 py-1.5 rounded text-xs font-medium bg-rose-500 hover:bg-rose-600 text-white disabled:opacity-50"
                        >
                          {t("admin.persona.leave.reject")}
                        </button>
                      </div>
                    )}
                    {r.status !== "pending" && (
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        r.status === "approved" ? "bg-emerald-100 text-emerald-700" :
                        r.status === "rejected" ? "bg-rose-100 text-rose-700" :
                        "bg-slate-100 text-slate-500"
                      }`}>
                        {t(`leave.status.${r.status}` as any)}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {decideTarget && (
        <DecisionModal
          decision={decideTarget.decision}
          note={decideNote}
          onChange={setDecideNote}
          onConfirm={confirmDecide}
          onCancel={() => setDecideTarget(null)}
          busy={busyId === decideTarget.id}
          translate={t}
          nsPrompt="admin.persona.resignation"
          forfeitSvc={forfeitSvc}
          onForfeitSvcChange={setForfeitSvc}
          improperResignationConsequences={improperResignationConsequences}
        />
      )}
      {ConfirmDialog}
    </>
  );
}

// ── Policy editor (2026-05-28) ─────────────────────────────────────
//
// Two HR-policy strings the owner wants to author next to where the
// resignation requests actually surface. Saves via the dedicated
// PATCH /api/admin/persona/resignation/settings endpoint (admin-role,
// not super_admin gated) so branch admins can edit without bouncing
// to /admin/system-settings.
//
// Render: collapsed by default so the page header stays scannable;
// admin clicks "ตั้งค่าข้อความ" to expand + edit.

function PolicyEditor({
  initialImproper
}: {
  initialImproper: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [improper, setImproper] = useState(initialImproper);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const dirty = improper !== initialImproper;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(
        apiUrl("/api/admin/persona/resignation/settings"),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            improper_resignation_consequences: improper
          })
        }
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message || j.error || "บันทึกไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: "บันทึกแล้ว" });
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: "เกิดข้อผิดพลาดเครือข่าย" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <button type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between text-left">
        <div>
          <div className="font-semibold text-slate-800 text-sm">
            ตั้งค่าข้อความ — ลาออกไม่ถูกระเบียบเสียสิทธิ์อะไรบ้าง
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">
            ข้อความเตือนที่แสดงในแบบฟอร์มลาออกของพนักงาน + ตอนแอดมินติ๊ก &quot;ลาออกไม่ถูกระเบียบ&quot;
          </p>
        </div>
        <span className="text-slate-400 text-xs">{open ? "▲ ปิด" : "▼ แก้ไข"}</span>
      </button>

      {open && (
        <div className="mt-4 space-y-4 pt-4 border-t border-slate-100">
          <div>
            <label className="label">
              หมายเหตุ — ลาออกไม่ถูกระเบียบจะเสียสิทธิ์อะไรบ้าง
            </label>
            <p className="text-[10px] text-slate-500 mt-0.5 mb-1.5">
              เว้นว่าง = ไม่แสดง
            </p>
            <textarea
              className="input"
              rows={5}
              maxLength={2000}
              value={improper}
              onChange={(e) => setImproper(e.target.value)}
              placeholder="เช่น&#10;· เสียสิทธิ์รับเงินส่วนแบ่ง Service Charge เดือนสุดท้าย&#10;· ไม่ได้รับโบนัสปลายปี&#10;· อาจต้องชดใช้เงินค่าฝึกอบรมตามที่ระบุในสัญญา"
            />
            <p className="text-[10px] text-slate-400 text-right">{improper.length} / 2000</p>
          </div>

          {msg && (
            <div className={`text-sm text-center ${
              msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
            }`}>
              {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
            </div>
          )}

          <button type="button"
            onClick={save}
            disabled={busy || !dirty}
            className="btn-primary w-full text-sm py-2.5">
            {busy ? "กำลังบันทึก…" : dirty ? "บันทึกการเปลี่ยนแปลง" : "ไม่มีการเปลี่ยนแปลง"}
          </button>

          <div className="text-[11px] text-slate-500 pt-2 border-t border-slate-100">
            ✦ ปรับแต่งข้อความ LINE ที่ส่งตอนเปิดสิทธิ์ลาออก ได้ที่หน้า{" "}
            <Link href="/admin/persona/notifications"
              className="text-brand hover:underline font-medium">
              ปรับแต่งการ์ดแจ้งเตือน
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
