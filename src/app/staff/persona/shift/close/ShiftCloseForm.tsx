"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { todayBkk } from "@/lib/time";
import PinPromptModal from "@/app/components/PinPromptModal";
import ShiftCloseFlexPreview from "./ShiftCloseFlexPreview";

// Post-shift checklist (เช็คลิสต์หลังเลิกงาน). Mirrors ShiftOpenForm
// without the "yesterday's closing" prefill — the closing-drawer
// amount the staff types here becomes the next day's "ยอดเงินปิดกะ
// เมื่อวาน" prefill on the pre-shift form.

type ChecklistItem = {
  id: number;
  label: string;
  kind: "checkbox" | "text" | "choice" | "amount" | "section";
  options?: string[];
  /** When set, child of another item — rendered indented. */
  parent_id?: number | null;
  /** Marks the amount row featured at top of the LINE Flex card. */
  is_headline?: boolean;
  /** Optional small-text help shown below the label. */
  description?: string | null;
};

/** Format a number as "12,345.67" baht for display. */
function fmtThb(n: number): string {
  return (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Normalise a baht amount to "12,345.67". Returns "" when invalid. */
function formatBahtAmount(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const n = Number(trimmed.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return "";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// Per-branch knobs that drive the live Flex preview. Each field
// optionally carries a custom label + display_order + the boolean
// "render in red box" toggle. NULL/missing → component falls back
// to the same hardcoded defaults the server-side card uses.
type DefaultFieldConfig = {
  closing_drawer: { label: string | null; display_order: number; in_red_box: boolean };
  service_charge: { label: string | null; display_order: number; in_red_box: boolean };
  daily_revenue:  { label: string | null; display_order: number; in_red_box: boolean };
};

// Mirror of MaterialQuota (server lib/accounta-db) — duplicated here so the
// client component doesn't import the server-only DB module.
type MaterialQuotaView = {
  weekdayLabel: string;
  monthBudget: number; spentThisMonth: number; remainingBudget: number;
  otherDaysLeft: number; todayIsPurchaseDay: boolean; quotaToday: number;
};

export default function ShiftCloseForm({
  branchId, branchName, closerName, checklistItems,
  requireServiceCharge = false,
  requireTodayClosing = true,
  requireDailyRevenue = true,
  incomeChannels = [],
  materialQuota = null,
  previousData = null,
  defaultFieldConfig
}: {
  branchId: number;
  branchName: string;
  closerName: string;
  checklistItems: ChecklistItem[];
  /** Per-branch income channels for the close breakdown (owner 2026-06-22).
   *  When non-empty, the form shows a per-channel entry and the day's total
   *  is the SUM of the channels (no separate total field, no reconciliation).
   *  is_credit channels count as sales but as outstanding (ค้างชำระ), not cash. */
  incomeChannels?: Array<{ id: number; name: string; is_credit?: number }>;
  /** Today's material-purchase quota (owner 2026-06-21). null = branch hasn't
   *  enabled the feature. Display-only; staff record what they ordered. */
  materialQuota?: MaterialQuotaView | null;
  /** Optional — when omitted, the preview uses hardcoded defaults. */
  defaultFieldConfig?: DefaultFieldConfig;
  /** When the branch admin has flipped require_service_charge ON,
   *  the staff form shows a mandatory "ยอดเซอร์วิสชาร์จวันนี้"
   *  field at the top. */
  requireServiceCharge?: boolean;
  /** When the branch admin has flipped require_today_closing ON
   *  (default), the staff form shows "ยอดเงินปิดกะวันนี้" as a
   *  mandatory top-level amount field — was removed 2026-05-23
   *  and brought back as a per-branch toggle 2026-05-25 per
   *  owner direction. The data lands in
   *  daily_reports.data.closing_drawer_amount for downstream
   *  reports / payroll reconciliation. */
  requireTodayClosing?: boolean;
  /** When the branch admin has flipped require_daily_revenue ON
   *  (default true 2026-05-28), the staff form shows an optional
   *  "ยอดขายวันนี้" field. Feeds branch_daily_revenue (ASCENDA COL %
   *  + sales growth) AND appears as a headline figure on the
   *  shift-close LINE Flex report. Optional — admin can backfill via
   *  /admin/ascenda/revenue if staff don't have the number at close. */
  requireDailyRevenue?: boolean;
  /** Most recent superseded report's parsed `data` JSON, if any.
   *  Passed in when admin previously granted an unlock so the form
   *  re-renders pre-filled with what the staff typed before. */
  previousData?: Record<string, unknown> | null;
}) {
  const router = useRouter();
  const { t } = useLang();

  // Pre-fill seed — when previousData carries a prior submission's
  // checklist, build per-id lookup maps once for the initial state.
  // Falls back to empty objects so the form behaves identically
  // when there's no prior submission (the common case).
  const prevByLabel = (() => {
    const m = new Map<string, {
      checked: boolean;
      note: string | null;
      kind?: string;
    }>();
    const arr = (previousData?.checklist ?? []) as Array<{
      label: string;
      checked: boolean;
      note?: string | null;
      kind?: string;
    }>;
    for (const it of arr) {
      m.set(it.label, {
        checked: !!it.checked,
        note: it.note ?? null,
        kind: it.kind
      });
    }
    return m;
  })();

  // Today's closing drawer amount — shown when requireTodayClosing
  // is on (default true). Persists into daily_reports.data.closing_
  // drawer_amount, surfaced on the LINE Flex card + admin reports.
  const [closingAmount, setClosingAmount] = useState<string>(() => {
    const v = previousData?.closing_drawer_amount;
    return typeof v === "number" ? String(v) : "";
  });

  // Service Charge collected from POS today. Only shown + required
  // when requireServiceCharge prop is true. Persisted into
  // daily_service_charge via the daily-report API. Pre-fills from
  // previousData.service_charge_amount if it's a number; otherwise
  // empty so the user can leave-blank-then-fill flow works.
  const [svcAmount, setSvcAmount] = useState<string>(() => {
    const v = previousData?.service_charge_amount;
    return typeof v === "number" ? String(v) : "";
  });
  // 2026-05-27: ASCENDA daily revenue (ยอดขายวันนี้). Optional —
  // staff can skip; admin backfills via /admin/ascenda/revenue.
  // Lands in branch_daily_revenue (NOT in daily_reports.data) so the
  // ASCENDA COL/sales-growth calculators have a clean source.
  const [dailyRevenue, setDailyRevenue] = useState<string>("");
  // Per-channel sales (owner 2026-06-21). Keyed by channel id. Empty is
  // treated as 0 — every channel is always shown, staff fill the ones with
  // sales. The sum must equal ยอดขายวันนี้ exactly or submit is blocked.
  const [channelAmounts, setChannelAmounts] = useState<Record<number, string>>(() =>
    Object.fromEntries(incomeChannels.map((c) => [c.id, ""]))
  );
  // Material ordered today (owner 2026-06-21) — only when the branch enabled
  // the quota feature. Blank = 0. Compared to today's quota on the report.
  const [materialOrdered, setMaterialOrdered] = useState<string>("");
  const [checked, setChecked] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(checklistItems.map((it) => {
      const prev = prevByLabel.get(it.label);
      // Only restore the checked bool for checkbox-kind rows —
      // text/choice/amount don't really have a meaningful "checked"
      // state visible to the user.
      const restored = prev && (it.kind === "checkbox" || !it.kind)
        ? prev.checked
        : false;
      return [it.id, restored];
    }))
  );
  const [notes, setNotes] = useState<Record<number, string>>(() =>
    Object.fromEntries(checklistItems.map((it) => {
      const prev = prevByLabel.get(it.label);
      // Restore the note for checkbox rows (skip-with-reason text).
      const restored = prev && (it.kind === "checkbox" || !it.kind)
        ? (prev.note ?? "")
        : "";
      return [it.id, restored];
    }))
  );
  // See ShiftOpenForm for the rationale — text items keep their value
  // here and we mirror them into the (checked, note) payload at submit
  // so downstream renderers (LINE Flex, audit) don't need to know about
  // kinds.
  const [textValues, setTextValues] = useState<Record<number, string>>(() =>
    Object.fromEntries(checklistItems.map((it) => {
      const prev = prevByLabel.get(it.label);
      let restored = "";
      if (prev && (it.kind === "text" || it.kind === "amount")) {
        restored = prev.note ?? "";
        // PREFILL BUG FIX (2026-05): amount items were saved with
        // Thai-style comma grouping ("1,000.00") by formatBahtAmount.
        // The amount renderer uses <input type="number"> which
        // refuses formatted strings and silently shows empty → admin
        // approved the unlock but staff still saw blank amount fields.
        // Strip commas on the way back into the input.
        if (it.kind === "amount") {
          restored = restored.replace(/,/g, "");
        }
      }
      return [it.id, restored];
    }))
  );
  // Choice items: the staff's picked option (or null until picked).
  const [choices, setChoices] = useState<Record<number, string | null>>(() =>
    Object.fromEntries(checklistItems.map((it) => {
      const prev = prevByLabel.get(it.label);
      const restored = prev && it.kind === "choice"
        ? (prev.note ?? null)
        : null;
      return [it.id, restored];
    }))
  );
  const [openNotes, setOpenNotes] = useState<Record<number, boolean>>({});
  const [errorIds, setErrorIds] = useState<Record<number, boolean>>({});

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [done, setDone] = useState(false);
  // PIN gate state — holds the pending submit payload while the PIN modal is open.
  const [pinOpen, setPinOpen] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<Record<string, unknown> | null>(null);

  function toggleAll(value: boolean) {
    setChecked((prev) => ({
      ...prev,
      ...Object.fromEntries(
        checklistItems
          .filter((it) => it.kind === "checkbox" || !it.kind)
          .map((it) => [it.id, value])
      )
    }));
  }

  function parseAmount(s: string): number | null {
    const trimmed = s.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed.replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  // Per-channel model (owner 2026-06-22). The day's total IS the sum of the
  // channels — no separate total field, no reconciliation. is_credit channels
  // count toward sales (accrual) but as outstanding (ค้างชำระ), not cash.
  const channelsActive = incomeChannels.length > 0;
  const round2c = (n: number) => Math.round(n * 100) / 100;
  const amtOf = (c: { id: number }) => parseAmount(channelAmounts[c.id] ?? "") ?? 0;
  const channelSum = round2c(incomeChannels.reduce((s, c) => s + amtOf(c), 0));      // total sales (accrual)
  const cashSum = round2c(incomeChannels.filter((c) => !c.is_credit).reduce((s, c) => s + amtOf(c), 0));
  const creditSum = round2c(incomeChannels.filter((c) => c.is_credit).reduce((s, c) => s + amtOf(c), 0));
  // When channels drive the form, the daily total comes from them; otherwise
  // it's the manual "ยอดขายวันนี้" field.
  const dailyTotal = channelsActive ? channelSum : parseAmount(dailyRevenue);

  /** Build and validate the payload, then open the PIN modal.
   *  Actual POST happens in submitWithPin() after PIN is entered. */
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const missingNoteIds = checklistItems
      .filter((it) => {
        // 'section' = non-interactive header, never counted as missing.
        if (it.kind === "section") return false;
        if (it.kind === "text" || it.kind === "amount") {
          return !((textValues[it.id] || "").trim());
        }
        if (it.kind === "choice") return !choices[it.id];
        return !checked[it.id] && !((notes[it.id] || "").trim());
      })
      .map((it) => it.id);
    if (missingNoteIds.length > 0) {
      setErrorIds(Object.fromEntries(missingNoteIds.map((id) => [id, true])));
      setOpenNotes((prev) => ({
        ...prev,
        ...Object.fromEntries(missingNoteIds.map((id) => [id, true]))
      }));
      setMsg({
        kind: "err",
        text: t("staff.persona.shift.open.requireNoteForUnchecked", {
          n: String(missingNoteIds.length)
        })
      });
      return;
    }
    // Service charge — only validate when admin requires it. Empty
    // when required = block submit with friendly message.
    if (requireTodayClosing && parseAmount(closingAmount) == null) {
      setMsg({
        kind: "err",
        text: t("staff.persona.shift.close.field.closingAmountRequired")
      });
      setBusy(false);
      return;
    }
    if (requireServiceCharge && parseAmount(svcAmount) == null) {
      setMsg({
        kind: "err",
        text: t("staff.persona.shift.close.svcRequired")
      });
      return;
    }
    setErrorIds({});
    setBusy(true);
    try {
      // closing_drawer_amount — back as a top-level required field
      // (2026-05-25). Null when the toggle is off so existing flow
      // for branches that opt out still works.
      const closingParsed = requireTodayClosing ? parseAmount(closingAmount) : null;
      const svcParsed = parseAmount(svcAmount);
      // Flatten parents-then-children; mark child rows with is_child=true
      // so the LINE Flex renderer indents them under their parent.
      const buildEntry = (it: ChecklistItem, isChild: boolean) => {
        const headlineFlag = it.kind === "amount" && it.is_headline
          ? { is_headline: true }
          : {};
        const descriptionPart = it.description?.trim()
          ? { description: it.description.trim() }
          : {};
        // 'section' header — non-interactive but shipped in payload so
        // the LINE Flex renders the group title inline.
        if (it.kind === "section") {
          return {
            label: it.label,
            kind: "section" as const,
            checked: false,
            note: null,
            ...(isChild ? { is_child: true } : {}),
            ...descriptionPart
          };
        }
        if (it.kind === "text" || it.kind === "amount") {
          const value = (textValues[it.id] || "").trim();
          const formatted = it.kind === "amount" && value
            ? formatBahtAmount(value)
            : value;
          return {
            label: it.label,
            kind: it.kind,
            checked: !!value,
            note: formatted || null,
            ...(isChild ? { is_child: true } : {}),
            ...headlineFlag,
            ...descriptionPart
          };
        }
        if (it.kind === "choice") {
          const sel = choices[it.id];
          return {
            label: it.label,
            kind: "choice" as const,
            checked: !!sel,
            note: sel ?? null,
            ...(isChild ? { is_child: true } : {}),
            ...descriptionPart
          };
        }
        const note = (notes[it.id] || "").trim();
        return {
          label: it.label,
          kind: "checkbox" as const,
          checked: !!checked[it.id],
          note: note ? note : null,
          ...(isChild ? { is_child: true } : {}),
          ...descriptionPart
        };
      };
      const topLevelItems = checklistItems.filter((it) => !it.parent_id);
      const checklistPayload: Array<ReturnType<typeof buildEntry>> = [];
      for (const parent of topLevelItems) {
        checklistPayload.push(buildEntry(parent, false));
        for (const k of checklistItems.filter((c) => c.parent_id === parent.id)) {
          checklistPayload.push(buildEntry(k, true));
        }
      }

      // Validation passed — open PIN modal with pending payload.
      // The actual POST runs in submitWithPin() after PIN entry.
      setPendingPayload({
        type: "shift_close",
        branch_id: branchId,
        data: {
          closing_drawer_amount: closingParsed,
          service_charge_amount: svcParsed,
          daily_revenue: dailyTotal,
          material_ordered_today: materialQuota ? (parseAmount(materialOrdered) ?? 0) : null,
          channel_amounts: channelsActive
            ? incomeChannels.map((c) => ({
                channel_id: c.id,
                channel: c.name,
                amount: parseAmount(channelAmounts[c.id] ?? "") ?? 0,
                is_credit: !!c.is_credit
              }))
            : [],
          checklist: checklistPayload
        }
      });
      setPinOpen(true);
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally {
      setBusy(false);
    }
  }

  /** Called by PinPromptModal after PIN entry — adds pin to payload and POSTs. */
  async function submitWithPin(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!pendingPayload) return { ok: false, message: "ไม่มีข้อมูลที่จะส่ง" };
    try {
      const res = await fetch(apiUrl("/api/persona/daily-report"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...pendingPayload, pin })
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 409 && j.error === "already_submitted") {
        router.refresh();
        setPinOpen(false);
        return { ok: true };
      }
      if (!res.ok || !j.ok) {
        const pinErr = j?.error === "wrong_pin" || j?.error === "pin_invalid"
          ? "PIN ไม่ถูกต้อง"
          : j?.error === "no_pin"
            ? "ยังไม่ได้ตั้ง PIN — ไปตั้งที่หน้าลงเวลาก่อน"
            : j?.message ?? t("common.error");
        return { ok: false, message: pinErr };
      }
      setPinOpen(false);
      setDone(true);
      router.refresh();
      return { ok: true };
    } catch {
      return { ok: false, message: t("common.error") };
    }
  }

  if (done) {
    return (
      <div className="card text-center space-y-3">
        <div className="text-5xl">✓</div>
        <h2 className="text-xl font-bold text-slate-800">
          {t("staff.persona.shiftReport.submitted.title")}
        </h2>
        <p className="text-sm text-slate-600">
          {t("staff.persona.shiftReport.submitted.body", {
            type: t("staff.persona.shiftReport.typeLabel.shiftClose"),
            branch: branchName
          })}
        </p>
        <button type="button" onClick={() => router.push("/staff/persona")}
          className="btn-secondary w-full">
          {t("common.back")}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="card space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">{t("staff.persona.shift.open.field.opener")}</label>
            <input type="text" className="input bg-slate-50 text-slate-500"
              value={closerName} readOnly />
          </div>
          <div>
            <label className="label">
              {t("staff.persona.shift.open.field.branch")}
            </label>
            <input type="text" className="input bg-slate-50 text-slate-500"
              value={branchName} readOnly />
          </div>
        </div>

        {/* Closing-drawer field removed 2026-05-23 — admins now own
            the checklist schema entirely (they can add a kind=amount
            row for closing-drawer with their preferred label). The
            duplicate top-level + checklist version was confusing. */}

        {/* Today's closing drawer — required-by-default per-branch
            toggle (2026-05-25). Sits above the SVC field because
            it's the most-used metric for end-of-day reconciliation. */}
        {requireTodayClosing && (
          <div>
            <label className="label">{t("staff.persona.shift.close.field.closingAmount")} *</label>
            <input type="number" inputMode="decimal" min={0} step="0.01"
              required
              className="input"
              value={closingAmount}
              placeholder="0.00"
              onChange={(e) => setClosingAmount(e.target.value)} />
            <p className="text-[10px] text-slate-400 mt-1">
              {t("staff.persona.shift.close.field.closingAmountHint")}
            </p>
          </div>
        )}

        {/* Service Charge — only when branch admin has flipped the
            require_service_charge toggle on. Feeds the staff-share
            calculator at /admin/persona/service-charge. */}
        {requireServiceCharge && (
          <div>
            <label className="label">{t("staff.persona.shift.close.field.svcAmount")} *</label>
            <input type="number" inputMode="decimal" min={0} step="0.01"
              required
              className="input"
              value={svcAmount}
              placeholder="0.00"
              onChange={(e) => setSvcAmount(e.target.value)} />
            <p className="text-[10px] text-slate-400 mt-1">
              {t("staff.persona.shift.close.field.svcAmountHint")}
            </p>
          </div>
        )}

        {/* ASCENDA daily revenue — per-branch toggle (2026-05-28).
            Optional when shown. Feeds the COL % + sales-growth %
            auto-calculators AND appears as a headline figure on the
            LINE Flex report. Staff can skip; admin backfills via
            /admin/ascenda/revenue. */}
        {requireDailyRevenue && !channelsActive && (
          <div>
            <label className="label">ยอดขายวันนี้ (บาท)</label>
            <input type="number" inputMode="decimal" min={0} step="0.01"
              className="input"
              value={dailyRevenue}
              placeholder="0.00 (ไม่บังคับ)"
              onChange={(e) => setDailyRevenue(e.target.value)} />
            <p className="text-[10px] text-slate-400 mt-1">
              ใช้คำนวณ KPI ASCENDA (COL % และยอดขายโต) · เว้นว่างได้ถ้ายังไม่ทราบ
            </p>
          </div>
        )}
      </div>

      {/* ยอดขายแยกช่องทาง — driven by the master income-channel list
          (owner 2026-06-21). Every active channel is shown; staff fill
          the ones with sales (blank = 0). The sum must equal ยอดขายวันนี้
          exactly or the form blocks submit. */}
      {channelsActive && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="font-bold text-slate-800">ยอดขายแยกช่องทางการรับเงิน</h2>
            <span className="text-[11px] text-slate-400">ช่องทางที่ไม่มียอดวันนี้ ใส่ 0 หรือเว้นว่าง</span>
          </div>
          <div className="space-y-1.5">
            {incomeChannels.map((c) => (
              <div key={c.id} className="space-y-1">
                <label className="flex items-center gap-1.5 text-sm text-slate-700">
                  {c.name}
                  {!!c.is_credit && (
                    <span className="text-[10px] font-normal bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-1.5 py-px">ค้างชำระ</span>
                  )}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" inputMode="decimal" min="0" step="0.01"
                    className="input text-sm font-mono text-right flex-1"
                    placeholder="0.00"
                    value={channelAmounts[c.id] ?? ""}
                    onChange={(e) => setChannelAmounts((p) => ({ ...p, [c.id]: e.target.value }))}
                    onBlur={() => {
                      const v = (channelAmounts[c.id] ?? "").trim();
                      if (!v) return;
                      const n = Number(v.replace(/,/g, ""));
                      if (Number.isFinite(n) && n >= 0) {
                        setChannelAmounts((p) => ({ ...p, [c.id]: n.toFixed(2) }));
                      }
                    }}
                  />
                  <span className="text-sm font-bold text-slate-500 select-none">฿</span>
                </div>
              </div>
            ))}
          </div>
          {/* Live totals — total sales (accrual) = sum; cash vs outstanding split */}
          <div className="rounded-lg p-3 text-sm space-y-1 border bg-slate-50 border-slate-200">
            <div className="flex justify-between">
              <span className="text-slate-600">เงินเข้าจริงวันนี้</span>
              <b className="font-mono text-emerald-700">฿{fmtThb(cashSum)}</b>
            </div>
            {creditSum > 0 && (
              <div className="flex justify-between">
                <span className="text-slate-600">ค้างชำระ (ลูกหนี้)</span>
                <b className="font-mono text-amber-700">฿{fmtThb(creditSum)}</b>
              </div>
            )}
            <div className="flex justify-between border-t border-slate-200 pt-1 mt-1">
              <span className="font-bold text-slate-700">ยอดขายรวมวันนี้</span>
              <b className="font-mono text-slate-900">฿{fmtThb(channelSum)}</b>
            </div>
          </div>
        </div>
      )}

      {/* Material-purchase quota (owner 2026-06-21). Shows today's buying
          quota + records what was ordered; flags over-quota on the report. */}
      {materialQuota && (() => {
        const ordered = parseAmount(materialOrdered) ?? 0;
        const over = ordered > materialQuota.quotaToday + 0.005;
        return (
          <div className="card space-y-3">
            <h2 className="font-bold text-slate-800">โควตาสั่งซื้อวัตถุดิบวันนี้</h2>
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-center">
              <div className="text-[11px] text-slate-500">
                โควตาที่สั่งได้วันนี้
                {materialQuota.todayIsPurchaseDay
                  ? ` · วัน${materialQuota.weekdayLabel} (วันสั่งหลัก = งบเดือน ÷ 30)`
                  : " · วันปกติ (เฉลี่ยงบที่เหลือ)"}
              </div>
              <div className="text-2xl font-bold text-emerald-700">฿{fmtThb(materialQuota.quotaToday)}</div>
              <div className="text-[11px] text-slate-500 mt-1">
                งบเดือนนี้ ฿{fmtThb(materialQuota.monthBudget)} · ซื้อไปแล้ว ฿{fmtThb(materialQuota.spentThisMonth)}
                {materialQuota.todayIsPurchaseDay
                  ? ""
                  : ` · เฉลี่ยจากวันที่เหลืออีก ${materialQuota.otherDaysLeft} วัน`}
              </div>
            </div>
            <div>
              <label className="label">มูลค่าวัตถุดิบที่สั่งวันนี้ (บาท)</label>
              <input type="number" inputMode="decimal" min={0} step="0.01" className="input"
                value={materialOrdered} placeholder="0.00 (ไม่มีก็ใส่ 0)"
                onChange={(e) => setMaterialOrdered(e.target.value)} />
            </div>
            {ordered > 0 && (
              <div className={`rounded-lg p-2.5 text-sm font-bold text-center border ${
                over ? "bg-rose-50 border-rose-200 text-rose-700" : "bg-emerald-50 border-emerald-200 text-emerald-700"
              }`}>
                {over
                  ? `⚠ เกินโควตา ฿${fmtThb(ordered - materialQuota.quotaToday)} (สั่ง ฿${fmtThb(ordered)} / โควตา ฿${fmtThb(materialQuota.quotaToday)})`
                  : `✓ ปกติ — อยู่ในโควตา (สั่ง ฿${fmtThb(ordered)} / โควตา ฿${fmtThb(materialQuota.quotaToday)})`}
              </div>
            )}
          </div>
        );
      })()}

      {checklistItems.length > 0 ? (
        <div className="card space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="font-bold text-slate-800">
              {t("staff.persona.shift.close.checklistTitle")}
            </h2>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => toggleAll(true)}
                className="px-2.5 py-1 text-xs rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50">
                {t("staff.persona.shift.open.checkAll")}
              </button>
              <button type="button" onClick={() => toggleAll(false)}
                className="px-2.5 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50">
                {t("staff.persona.shift.open.uncheckAll")}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {/* Reorder so each parent is immediately followed by its
                children. Display-order alone may interleave across
                parent groups since children get their own
                display_order scoped to their parent. */}
            {(() => {
              const ordered: ChecklistItem[] = [];
              for (const p of checklistItems.filter((it) => !it.parent_id)) {
                ordered.push(p);
                for (const c of checklistItems.filter((c) => c.parent_id === p.id)) {
                  ordered.push(c);
                }
              }
              return ordered.map((it) => {
              const hasError = !!errorIds[it.id];
              const isChild = !!it.parent_id;
              const indentCls = isChild ? "ml-4 pl-3 border-l-2 border-slate-200" : "";
              if (it.kind === "section") {
                return (
                  <div key={it.id} className={`${indentCls} pt-3 pb-1`}>
                    <div className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">
                      {it.label}
                    </div>
                    {it.description?.trim() && (
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        {it.description.trim()}
                      </div>
                    )}
                  </div>
                );
              }
              if (it.kind === "choice") {
                const sel = choices[it.id];
                const opts = it.options ?? [];
                const cls = hasError
                  ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                  : sel
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-slate-200";
                return (
                  <div key={it.id} className={`${indentCls} rounded-xl border-[1.5px] transition p-3 ${cls}`}>
                    <div className={`block text-sm font-bold text-slate-800 ${it.description ? "" : "mb-2"}`}>
                      {it.label}
                    </div>
                    {it.description && (
                      <p className="text-[10px] text-slate-500 mb-2 mt-0.5 whitespace-pre-wrap">
                        {it.description}
                      </p>
                    )}
                    <div className="flex gap-2 flex-wrap">
                      {opts.map((opt) => {
                        const picked = sel === opt;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => {
                              setChoices((prev) => ({ ...prev, [it.id]: opt }));
                              if (hasError) {
                                setErrorIds((prev) => {
                                  const next = { ...prev };
                                  delete next[it.id];
                                  return next;
                                });
                              }
                            }}
                            className={`flex-1 min-w-[100px] py-2.5 px-3 rounded-lg text-sm font-bold transition-all border-2 ${
                              picked
                                ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                                : "border-slate-200 text-slate-500 hover:border-slate-300"
                            }`}
                          >
                            {picked ? "● " : ""}{opt}
                          </button>
                        );
                      })}
                    </div>
                    {hasError && (
                      <p className="text-[10px] text-rose-600 font-medium mt-1.5">
                        {t("staff.persona.shift.open.choiceRequired")}
                      </p>
                    )}
                  </div>
                );
              }
              if (it.kind === "text") {
                const value = textValues[it.id] || "";
                const filled = value.trim().length > 0;
                const cls = hasError
                  ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                  : filled
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-slate-200 hover:border-slate-300";
                return (
                  <div
                    key={it.id}
                    className={`${indentCls} rounded-xl border-[1.5px] transition p-3 ${cls}`}
                  >
                    <label className={`block text-sm font-medium text-slate-700 ${it.description ? "" : "mb-1.5"}`}>
                      {it.label}
                    </label>
                    {it.description && (
                      <p className="text-[10px] text-slate-500 mb-1.5 mt-0.5 whitespace-pre-wrap">
                        {it.description}
                      </p>
                    )}
                    <input
                      type="text"
                      className={`input text-sm ${hasError ? "border-rose-400 focus:border-rose-500" : ""}`}
                      maxLength={500}
                      value={value}
                      placeholder={t("staff.persona.shift.open.textValuePlaceholder")}
                      onChange={(e) => {
                        setTextValues((prev) => ({
                          ...prev,
                          [it.id]: e.target.value
                        }));
                        if (e.target.value.trim() && hasError) {
                          setErrorIds((prev) => {
                            const next = { ...prev };
                            delete next[it.id];
                            return next;
                          });
                        }
                      }}
                    />
                    {hasError && (
                      <p className="text-[10px] text-rose-600 font-medium mt-1">
                        {t("staff.persona.shift.open.textValueRequired")}
                      </p>
                    )}
                  </div>
                );
              }
              if (it.kind === "amount") {
                const value = textValues[it.id] || "";
                const filled = value.trim().length > 0;
                const cls = hasError
                  ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                  : filled
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-slate-200 hover:border-slate-300";
                return (
                  <div
                    key={it.id}
                    className={`${indentCls} rounded-xl border-[1.5px] transition p-3 ${cls}`}
                  >
                    <label className={`block text-sm font-medium text-slate-700 ${it.description ? "" : "mb-1.5"}`}>
                      {it.label}
                    </label>
                    {it.description && (
                      <p className="text-[10px] text-slate-500 mb-1.5 mt-0.5 whitespace-pre-wrap">
                        {it.description}
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0"
                        className={`input text-sm flex-1 font-mono ${hasError ? "border-rose-400 focus:border-rose-500" : ""}`}
                        placeholder="0.00"
                        value={value}
                        onChange={(e) => {
                          setTextValues((prev) => ({ ...prev, [it.id]: e.target.value }));
                          if (e.target.value.trim() && hasError) {
                            setErrorIds((prev) => {
                              const next = { ...prev };
                              delete next[it.id];
                              return next;
                            });
                          }
                        }}
                        onBlur={() => {
                          const trimmed = value.trim();
                          if (!trimmed) return;
                          const n = Number(trimmed.replace(/,/g, ""));
                          if (Number.isFinite(n) && n >= 0) {
                            setTextValues((prev) => ({
                              ...prev,
                              [it.id]: n.toFixed(2)
                            }));
                          }
                        }}
                      />
                      <span className="text-sm font-bold text-slate-600 select-none">฿</span>
                    </div>
                    {hasError && (
                      <p className="text-[10px] text-rose-600 font-medium mt-1">
                        {t("staff.persona.shift.open.textValueRequired")}
                      </p>
                    )}
                  </div>
                );
              }
              const isChecked = !!checked[it.id];
              const note = notes[it.id] || "";
              const hasNote = note.trim().length > 0;
              const isOpen = !!openNotes[it.id];
              const containerCls = hasError
                ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                : isChecked
                  ? "border-emerald-300 bg-emerald-50"
                  : hasNote
                    ? "border-amber-300 bg-amber-50"
                    : "border-slate-200 hover:border-slate-300";
              return (
                <div
                  key={it.id}
                  className={`${indentCls} rounded-xl border-[1.5px] transition ${containerCls}`}
                >
                  <label className="flex items-center gap-3 p-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="w-5 h-5 flex-shrink-0"
                      checked={isChecked}
                      onChange={(e) => {
                        setChecked((prev) => ({
                          ...prev,
                          [it.id]: e.target.checked
                        }));
                        if (e.target.checked) {
                          setErrorIds((prev) => {
                            const next = { ...prev };
                            delete next[it.id];
                            return next;
                          });
                        }
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm">{it.label}</span>
                      {it.description && (
                        <p className="text-[10px] text-slate-500 mt-0.5 whitespace-pre-wrap">
                          {it.description}
                        </p>
                      )}
                    </div>
                    <span className={`text-xs font-bold ${
                      isChecked ? "text-emerald-700"
                        : hasNote ? "text-amber-700"
                        : "text-slate-400"
                    }`}>
                      {isChecked ? "✓" : hasNote ? "📝" : "✗"}
                    </span>
                  </label>

                  <div className="px-3 pb-2.5 -mt-1 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setOpenNotes((prev) => ({
                        ...prev,
                        [it.id]: !prev[it.id]
                      }))}
                      className={`text-[11px] font-medium tracking-[0.5px] ${
                        hasNote ? "text-amber-700" : "text-slate-400 hover:text-brand"
                      }`}
                    >
                      {hasNote
                        ? `📝 ${t("staff.persona.shift.open.noteExists")}`
                        : `+ ${t("staff.persona.shift.open.addNote")}`}
                    </button>
                    {hasNote && !isOpen && (
                      <span className="text-[11px] text-amber-700/80 truncate flex-1">
                        — {note.trim()}
                      </span>
                    )}
                  </div>

                  {isOpen && (
                    <div className="px-3 pb-3">
                      <textarea
                        className={`input text-sm ${hasError ? "border-rose-400 focus:border-rose-500" : ""}`}
                        rows={2}
                        maxLength={500}
                        placeholder={t("staff.persona.shift.open.notePlaceholder")}
                        value={note}
                        onChange={(e) => {
                          setNotes((prev) => ({
                            ...prev,
                            [it.id]: e.target.value
                          }));
                          if (e.target.value.trim() && hasError) {
                            setErrorIds((prev) => {
                              const next = { ...prev };
                              delete next[it.id];
                              return next;
                            });
                          }
                        }}
                      />
                      <p className={`text-[10px] mt-1 ${
                        hasError ? "text-rose-600 font-medium" : "text-slate-400"
                      }`}>
                        {hasError
                          ? t("staff.persona.shift.open.requireNoteRowHint")
                          : t("staff.persona.shift.open.noteHint")}
                      </p>
                    </div>
                  )}
                </div>
              );
              });
            })()}
          </div>
          <p className="text-xs text-slate-400">
            {t("staff.persona.shift.open.checklistHint")}
          </p>
        </div>
      ) : (
        <div className="card text-xs text-slate-500 text-center">
          {t("staff.persona.shift.open.checklistEmptyForBranch")}
        </div>
      )}

      {/* Live preview — shows the LINE Flex card that will be POSTed
          to the staff group on submit. Updates as the user types
          amounts and ticks checklist items. Hidden via collapse so
          first-time users aren't overwhelmed; the toggle remembers
          state within the form (resets on page reload, which is
          acceptable). */}
      <PreviewBlock
        branchName={branchName}
        closerName={closerName}
        closingAmount={closingAmount}
        svcAmount={svcAmount}
        dailyRevenue={channelsActive ? String(channelSum) : dailyRevenue}
        requireServiceCharge={requireServiceCharge}
        requireTodayClosing={requireTodayClosing}
        requireDailyRevenue={requireDailyRevenue}
        checklistItems={checklistItems}
        checked={checked}
        notes={notes}
        textValues={textValues}
        choices={choices}
        config={defaultFieldConfig}
        channels={channelsActive
          ? incomeChannels.map((c) => ({ name: c.name, amount: amtOf(c), isCredit: !!c.is_credit }))
          : []}
      />

      {msg && (
        <div className={`text-sm text-center ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
        </div>
      )}

      <button type="submit" disabled={busy}
        className="btn-primary w-full text-base py-3.5 disabled:opacity-50">
        {busy
          ? t("staff.persona.shift.open.submitting")
          : t("staff.persona.shift.close.submit")}
      </button>

      {pinOpen && (
        <PinPromptModal
          title="ยืนยันตัวตนก่อนส่งรายงาน"
          description={
            <span>
              ใส่ PIN 4 หลักของคุณเพื่อยืนยันการปิดกะ{" "}
              <span className="font-bold text-slate-800">{branchName}</span>
            </span>
          }
          submitLabel="ส่งรายงานปิดกะ"
          onClose={() => setPinOpen(false)}
          onSubmit={submitWithPin}
        />
      )}
    </form>
  );
}

/** Inline collapsible "see what's about to be sent" preview block.
 *  Pulled out as a sub-component so the main form's render stays
 *  readable; all state lives one level up and is forwarded as props.
 *  Keeps its own collapsed/expanded boolean — independent of the
 *  parent's submit/validation lifecycle. */
function PreviewBlock(props: {
  branchName: string;
  closerName: string;
  closingAmount: string;
  svcAmount: string;
  dailyRevenue: string;
  requireServiceCharge: boolean;
  requireTodayClosing: boolean;
  requireDailyRevenue: boolean;
  checklistItems: ChecklistItem[];
  checked: Record<number, boolean>;
  notes: Record<number, string>;
  textValues: Record<number, string>;
  choices: Record<number, string | null>;
  config?: DefaultFieldConfig;
  channels?: Array<{ name: string; amount: number; isCredit?: boolean }>;
}) {
  const [open, setOpen] = useState(false);

  // Build the default-field rows the preview consumes.
  const cfg = props.config;
  const defaultFields = [
    {
      key: "closing_drawer" as const,
      amount: props.requireTodayClosing && props.closingAmount.trim()
        ? Number(props.closingAmount.replace(/,/g, ""))
        : null,
      label: cfg?.closing_drawer.label?.trim() || "ยอดเงินปิดงาน",
      display_order: cfg?.closing_drawer.display_order ?? 1,
      in_red_box: cfg?.closing_drawer.in_red_box ?? true
    },
    {
      key: "service_charge" as const,
      amount: props.requireServiceCharge && props.svcAmount.trim()
        ? Number(props.svcAmount.replace(/,/g, ""))
        : null,
      label: cfg?.service_charge.label?.trim() || "เซอร์วิสชาร์จวันนี้",
      display_order: cfg?.service_charge.display_order ?? 2,
      in_red_box: cfg?.service_charge.in_red_box ?? true
    },
    {
      key: "daily_revenue" as const,
      amount: props.requireDailyRevenue && props.dailyRevenue.trim()
        ? Number(props.dailyRevenue.replace(/,/g, ""))
        : null,
      label: cfg?.daily_revenue.label?.trim() || "ยอดขายวันนี้",
      display_order: cfg?.daily_revenue.display_order ?? 3,
      in_red_box: cfg?.daily_revenue.in_red_box ?? true
    }
  ].map((f) => ({
    ...f,
    amount: f.amount != null && Number.isFinite(f.amount) ? f.amount : null
  }));

  // Build checklist rows mirroring what the server-side card
  // receives. Skip section dividers (they're not on the card).
  const checklist = props.checklistItems
    .filter((it) => it.kind !== "section")
    .map((it) => {
      // textValues holds BOTH text and amount kinds (see line 169);
      // choice values live in `choices`. notes covers checkbox skip
      // reasons. Mirror the precedence the server-side normaliser
      // uses so the preview reads the same as what'll be POSTed.
      const note =
        it.kind === "text" || it.kind === "amount"
          ? (props.textValues[it.id] ?? "")
          : it.kind === "choice"
            ? (props.choices[it.id] ?? "")
            : (props.notes[it.id] ?? "");
      return {
        label: it.label,
        checked: it.kind === "checkbox" || !it.kind
          ? !!props.checked[it.id]
          : !!(note && note.trim()),
        note: note?.trim() || null,
        kind: it.kind
      };
    });

  return (
    <div className="border-2 border-dashed border-slate-300 rounded-xl p-2 bg-slate-50/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-sm font-bold text-slate-700 hover:text-brand px-2 py-1.5"
      >
        <span>🦉 ดูตัวอย่างการ์ดที่จะส่งเข้ากลุ่ม</span>
        <span className="text-xs">{open ? "▼ ซ่อน" : "▶ ดู"}</span>
      </button>
      {open && (
        <div className="mt-2">
          <ShiftCloseFlexPreview
            branchName={props.branchName}
            closerName={props.closerName}
            reportDate={todayBkk()}
            defaultFields={defaultFields}
            checklist={checklist}
            channels={props.channels}
          />
        </div>
      )}
    </div>
  );
}
