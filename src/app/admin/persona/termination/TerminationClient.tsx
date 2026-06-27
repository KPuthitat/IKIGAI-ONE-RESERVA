"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/app/components/useConfirm";

export type TermEmployee = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  employment_type: string | null;
  hire_date: string | null;
  monthly_salary: number | null;
  branch_name: string | null;
};

type TerminationType = "probation_fail" | "just_cause" | "no_cause" | "contract_end";

type TermRecord = {
  id: number;
  user_id: number;
  termination_type: TerminationType;
  reason: string;
  evidence_filename: string | null;
  effective_date: string;
  tenure_days: number | null;
  severance_days: number;
  severance_amount: number;
  severance_auto: number;
  status: "scheduled" | "executed" | "cancelled";
  ref_no: string | null;
  created_at: string;
  executed_at: string | null;
  employee_name: string;
  title_prefix: string | null;
  employment_type: string | null;
  branch_name: string | null;
  created_by_name: string | null;
};

const TYPE_TH: Record<TerminationType, string> = {
  probation_fail: "ไม่ผ่านทดลองงาน",
  just_cause: "เลิกจ้างมีความผิดร้ายแรง",
  no_cause: "เลิกจ้างไม่มีความผิด / ลดคน",
  contract_end: "สิ้นสุดสัญญาจ้าง"
};

const TYPE_HINT: Record<TerminationType, string> = {
  probation_fail: "อายุงาน < 120 วัน ไม่ต้องจ่ายค่าชดเชย",
  just_cause: "ม.119 — ไม่ต้องจ่ายค่าชดเชย ต้องมีหลักฐานชัด",
  no_cause: "จ่ายค่าชดเชยตามอายุงาน",
  contract_end: "ตรวจเงื่อนไขสัญญา — โดยทั่วไปจ่ายค่าชดเชยตามอายุงาน"
};

const STATUS_TH: Record<TermRecord["status"], string> = {
  scheduled: "รอถึงวันมีผล",
  executed: "เลิกจ้างแล้ว",
  cancelled: "ยกเลิกแล้ว"
};

// ── Severance bands — mirror lib/termination.ts (kept in sync by hand;
//    the server recomputes + is the source of truth on submit). ──
function tenureDays(hire: string | null, eff: string): number {
  if (!hire || !/^\d{4}-\d{2}-\d{2}$/.test(hire) || !/^\d{4}-\d{2}-\d{2}$/.test(eff)) return 0;
  const [hy, hm, hd] = hire.split("-").map(Number);
  const [ey, em, ed] = eff.split("-").map(Number);
  const ms = Date.UTC(ey, em - 1, ed) - Date.UTC(hy, hm - 1, hd);
  return ms > 0 ? Math.floor(ms / 86400_000) : 0;
}
function severanceDaysForTenure(days: number): number {
  if (days < 120) return 0;
  if (days < 365) return 30;
  if (days < 1095) return 90;
  if (days < 2190) return 180;
  if (days < 3650) return 240;
  if (days < 7300) return 300;
  return 400;
}
function bkkToday(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}
function fmtBaht(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function tenureLabel(days: number): string {
  if (days <= 0) return "—";
  const y = Math.floor(days / 365);
  const m = Math.floor((days % 365) / 30);
  if (y > 0) return `${y} ปี ${m} เดือน (${days} วัน)`;
  return `${m} เดือน (${days} วัน)`;
}

export default function TerminationClient({
  employees,
  records,
  canSeeSalary
}: {
  employees: TermEmployee[];
  records: TermRecord[];
  canSeeSalary: boolean;
}) {
  const router = useRouter();
  const { confirm, alert, ConfirmDialog } = useConfirm();
  const [employeeId, setEmployeeId] = useState<number | "">("");
  const [type, setType] = useState<TerminationType>("no_cause");
  const [effectiveDate, setEffectiveDate] = useState<string>(bkkToday());
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const [days, setDays] = useState<string>("0");
  const [amount, setAmount] = useState<string>("0");
  const [touched, setTouched] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<number | null>(null);

  const selected = useMemo(
    () => employees.find((e) => e.id === employeeId) ?? null,
    [employees, employeeId]
  );

  // Auto severance for the current (employee, type, date).
  const auto = useMemo(() => {
    const td = selected ? tenureDays(selected.hire_date, effectiveDate) : 0;
    const sevDays = type === "just_cause" ? 0 : severanceDaysForTenure(td);
    const daily = selected?.monthly_salary && selected.monthly_salary > 0 ? selected.monthly_salary / 30 : 0;
    const amt = Math.round(sevDays * daily * 100) / 100;
    return { tenureDays: td, sevDays, daily, amt };
  }, [selected, type, effectiveDate]);

  // Reset the editable fields to the auto figure whenever the inputs
  // change, unless the admin has manually overridden them.
  useEffect(() => {
    if (!touched) {
      setDays(String(auto.sevDays));
      setAmount(String(auto.amt));
    }
  }, [auto, touched]);

  const overridden = touched && (Number(days) !== auto.sevDays || Number(amount) !== auto.amt);

  async function submit() {
    setError(null);
    setDone(null);
    if (!employeeId) { setError("เลือกพนักงานก่อน"); return; }
    if (!reason.trim()) { setError("ระบุเหตุผลการเลิกจ้าง"); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) { setError("วันที่มีผลไม่ถูกต้อง"); return; }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("employee_id", String(employeeId));
      fd.set("type", type);
      fd.set("effective_date", effectiveDate);
      fd.set("reason", reason.trim());
      fd.set("severance_days", days || "0");
      fd.set("severance_amount", amount || "0");
      if (file) fd.set("file", file);
      const res = await fetch("/api/admin/persona/termination", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(errorTh(data?.error));
        return;
      }
      setDone(`บันทึกการเลิกจ้างแล้ว (${data.ref_no}) — บัญชีจะถูกล็อกหลังวันที่ ${effectiveDate}`);
      setEmployeeId("");
      setReason("");
      setFile(null);
      setTouched(false);
      router.refresh();
    } catch {
      setError("เกิดข้อผิดพลาด ลองใหม่อีกครั้ง");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel(id: number) {
    const ok = await confirm({ title: "ยกเลิกการเลิกจ้างรายการนี้?", body: "พนักงานจะยังทำงานต่อ", confirmLabel: "ยกเลิกการเลิกจ้าง", cancelLabel: "ปิด", variant: "warning" });
    if (ok === null) return;
    setCancelling(id);
    try {
      const res = await fetch(`/api/admin/persona/termination/${id}/cancel`, { method: "POST" });
      if (res.ok) router.refresh();
      else {
        const d = await res.json().catch(() => ({}));
        await alert({ title: errorTh(d?.error), variant: "danger" });
      }
    } finally {
      setCancelling(null);
    }
  }

  const scheduled = records.filter((r) => r.status === "scheduled");
  const history = records.filter((r) => r.status !== "scheduled");

  return (
    <div className="space-y-6">
      {ConfirmDialog}
      {/* ── Create form ── */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
        <h2 className="font-semibold text-slate-800">บันทึกการเลิกจ้างใหม่</h2>

        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-slate-500">พนักงาน</span>
            <select
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm"
              value={employeeId}
              onChange={(e) => { setEmployeeId(e.target.value ? Number(e.target.value) : ""); setTouched(false); }}
            >
              <option value="">— เลือกพนักงาน —</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {(e.title_prefix ? e.title_prefix + " " : "") + e.display_name}
                  {e.employment_type ? ` · ${e.employment_type.toUpperCase()}` : ""}
                  {e.branch_name ? ` · ${e.branch_name}` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs text-slate-500">ประเภทการเลิกจ้าง</span>
            <select
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm"
              value={type}
              onChange={(e) => { setType(e.target.value as TerminationType); setTouched(false); }}
            >
              {(Object.keys(TYPE_TH) as TerminationType[]).map((k) => (
                <option key={k} value={k}>{TYPE_TH[k]}</option>
              ))}
            </select>
            <span className="text-[11px] text-slate-400 mt-0.5 block">{TYPE_HINT[type]}</span>
          </label>

          <label className="block">
            <span className="text-xs text-slate-500">วันสุดท้ายของการทำงาน (วันมีผล)</span>
            <input
              type="date"
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm"
              value={effectiveDate}
              onChange={(e) => { setEffectiveDate(e.target.value); setTouched(false); }}
            />
            <span className="text-[11px] text-slate-400 mt-0.5 block">บัญชีจะถูกล็อกในเช้าวันถัดไป</span>
          </label>

          <label className="block">
            <span className="text-xs text-slate-500">แนบหลักฐาน (ไม่บังคับ)</span>
            <input
              type="file"
              accept="image/*,application/pdf"
              className="mt-1 w-full text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs text-slate-500">เหตุผล / รายละเอียด</span>
          <textarea
            className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="เช่น ไม่ผ่านการประเมินทดลองงาน / ขาดงานติดต่อกันโดยไม่แจ้ง"
          />
        </label>

        {/* Severance preview */}
        {selected && (
          <div className="rounded-md bg-slate-50 border border-slate-200 p-3 text-sm space-y-1.5">
            <div className="flex justify-between text-slate-600">
              <span>อายุงาน</span>
              <span className="font-medium">{tenureLabel(auto.tenureDays)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>ค่าชดเชยตามกฎหมาย</span>
              <span className="font-medium">
                {type === "just_cause" ? "ไม่จ่าย (มีความผิด)" : `${auto.sevDays} วันของค่าจ้าง`}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <label className="block">
                <span className="text-[11px] text-slate-500">จำนวนวัน</span>
                <input
                  type="number" min={0}
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  value={days}
                  onChange={(e) => { setDays(e.target.value); setTouched(true); }}
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-slate-500">ค่าชดเชย (บาท)</span>
                <input
                  type="number" min={0} step="0.01"
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  value={amount}
                  onChange={(e) => { setAmount(e.target.value); setTouched(true); }}
                />
              </label>
            </div>
            {!canSeeSalary && (
              <p className="text-[11px] text-amber-600">
                * คุณไม่มีสิทธิ์ดูเงินเดือน — ระบบจะคำนวณยอดค่าชดเชยจริงตอนบันทึก
              </p>
            )}
            {canSeeSalary && auto.daily > 0 && (
              <p className="text-[11px] text-slate-400">
                ค่าจ้างรายวัน ≈ {fmtBaht(auto.daily)} บาท (เงินเดือน ÷ 30)
              </p>
            )}
            {overridden && (
              <button
                type="button"
                className="text-[11px] text-brand hover:underline"
                onClick={() => setTouched(false)}
              >
                ↺ ใช้ค่าที่คำนวณอัตโนมัติ
              </button>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
        {done && <p className="text-sm text-emerald-600">{done}</p>}

        <div className="flex justify-end">
          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className="rounded-md bg-red-600 text-white px-4 py-2 text-sm font-medium hover:bg-red-700 disabled:opacity-50"
          >
            {submitting ? "กำลังบันทึก…" : "บันทึกการเลิกจ้าง"}
          </button>
        </div>
      </div>

      {/* ── Scheduled ── */}
      <div>
        <h2 className="font-semibold text-slate-800 mb-2">
          รอถึงวันมีผล {scheduled.length > 0 && <span className="text-slate-400">({scheduled.length})</span>}
        </h2>
        {scheduled.length === 0 ? (
          <p className="text-sm text-slate-400">ไม่มีรายการที่รอดำเนินการ</p>
        ) : (
          <div className="space-y-2">
            {scheduled.map((r) => (
              <RecordCard key={r.id} r={r} onCancel={cancel} cancelling={cancelling === r.id} />
            ))}
          </div>
        )}
      </div>

      {/* ── History ── */}
      {history.length > 0 && (
        <div>
          <h2 className="font-semibold text-slate-800 mb-2">ประวัติ</h2>
          <div className="space-y-2">
            {history.map((r) => (
              <RecordCard key={r.id} r={r} onCancel={cancel} cancelling={false} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RecordCard({
  r, onCancel, cancelling
}: {
  r: TermRecord;
  onCancel: (id: number) => void;
  cancelling: boolean;
}) {
  const statusColor =
    r.status === "scheduled" ? "bg-amber-100 text-amber-700" :
    r.status === "executed" ? "bg-red-100 text-red-700" :
    "bg-slate-100 text-slate-500";
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="font-medium text-slate-800">
            {(r.title_prefix ? r.title_prefix + " " : "") + r.employee_name}
            {r.branch_name && <span className="text-slate-400 font-normal"> · {r.branch_name}</span>}
          </div>
          <div className="text-slate-500 mt-0.5">
            {TYPE_TH[r.termination_type]} · วันมีผล {r.effective_date}
            {r.ref_no && <span className="text-slate-400"> · {r.ref_no}</span>}
          </div>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${statusColor}`}>
          {STATUS_TH[r.status]}
        </span>
      </div>
      <div className="mt-1.5 text-slate-600">{r.reason}</div>
      <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[12px] text-slate-500">
        <span>
          ค่าชดเชย: {r.severance_days} วัน
          {r.severance_amount > 0 && ` · ${r.severance_amount.toLocaleString("th-TH")} บาท`}
          {r.severance_auto === 0 && <span className="text-amber-600"> (แก้ไขเอง)</span>}
        </span>
        {r.evidence_filename && (
          <a
            href={`/api/admin/persona/termination/${r.id}/attachment`}
            target="_blank" rel="noreferrer"
            className="text-brand hover:underline"
          >
            ดูหลักฐาน
          </a>
        )}
        {r.status === "scheduled" && (
          <button
            type="button"
            disabled={cancelling}
            onClick={() => onCancel(r.id)}
            className="text-red-500 hover:underline disabled:opacity-50"
          >
            {cancelling ? "กำลังยกเลิก…" : "ยกเลิก"}
          </button>
        )}
      </div>
    </div>
  );
}

function errorTh(code: unknown): string {
  switch (code) {
    case "employee_not_active": return "พนักงานคนนี้ไม่ได้อยู่ในสถานะทำงาน";
    case "termination_already_exists": return "มีรายการเลิกจ้างของพนักงานคนนี้อยู่แล้ว";
    case "super_admin_required_for_role": return "ต้องเป็น super admin จึงจะเลิกจ้างผู้ดูแลระบบได้";
    case "cannot_terminate_self": return "ไม่สามารถเลิกจ้างตัวเองได้";
    case "reason_required": return "ระบุเหตุผลการเลิกจ้าง";
    case "invalid_date": return "วันที่มีผลไม่ถูกต้อง";
    case "file_too_large": return "ไฟล์ใหญ่เกินไป";
    case "file_type_not_allowed": return "ชนิดไฟล์ไม่รองรับ";
    case "not_scheduled": return "รายการนี้ไม่ได้อยู่ในสถานะรอดำเนินการแล้ว";
    default: return "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง";
  }
}
