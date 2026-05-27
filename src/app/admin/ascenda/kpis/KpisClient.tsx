"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
// Client component — import from ascenda-types so the browser bundle
// doesn't pull in better-sqlite3 via @/lib/ascenda.
import type { AscendaKpi, KpiKind, KpiScope, TargetOp } from "@/lib/ascenda-types";
import { kindLabelTh } from "@/lib/ascenda-types";

// Interactive KPI manager. Inline modal for add/edit, per-row buttons
// for reorder / toggle active / delete. Uses router.refresh() after
// each mutation so the server-rendered list stays in sync without
// us mirroring state client-side (the catalog is small — at most a
// few dozen rows even for a power user).

const KIND_GROUPS: Array<{ label: string; kinds: KpiKind[] }> = [
  { label: "อัตโนมัติ (ระบบคำนวณให้)", kinds: ["attendance_pct", "col_pct_auto", "sales_growth_pct"] },
  { label: "กรอกเอง — นับครั้ง",       kinds: ["incident_count", "wrong_order_count", "complaint_count"] },
  { label: "กรอกเอง — เปอร์เซ็นต์",     kinds: ["cog_pct", "manual_pct"] },
  { label: "กรอกเอง — ตัวเลขทั่วไป",    kinds: ["manual_number"] }
];

export default function KpisClient({ kpis }: { kpis: AscendaKpi[] }) {
  const router = useRouter();
  const [modal, setModal] = useState<
    | { mode: "create" }
    | { mode: "edit"; kpi: AscendaKpi }
    | null
  >(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function callApi(path: string, init: RequestInit) {
    const res = await fetch(apiUrl(path), {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) {
      const text = j.message || j.error || "เกิดข้อผิดพลาด";
      setMsg({ kind: "err", text });
      return false;
    }
    return true;
  }

  async function reorder(id: number, dir: "up" | "down") {
    setBusyId(id);
    setMsg(null);
    const ok = await callApi(`/api/admin/ascenda/kpis/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ reorder: dir })
    });
    setBusyId(null);
    if (ok) router.refresh();
  }

  async function toggleActive(kpi: AscendaKpi) {
    setBusyId(kpi.id);
    setMsg(null);
    const ok = await callApi(`/api/admin/ascenda/kpis/${kpi.id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: kpi.active === 1 ? 0 : 1 })
    });
    setBusyId(null);
    if (ok) router.refresh();
  }

  async function removeKpi(kpi: AscendaKpi) {
    const confirm = window.confirm(
      `ลบเกณฑ์ "${kpi.title}" จริงๆ ใช่ไหม?\n\n` +
      `ข้อมูลผลการประเมินย้อนหลังของเกณฑ์นี้จะหายตามไปด้วย — แนะนำให้ "ปิดใช้งาน" แทนถ้ายังอยากเก็บประวัติไว้`
    );
    if (!confirm) return;
    setBusyId(kpi.id);
    setMsg(null);
    const ok = await callApi(`/api/admin/ascenda/kpis/${kpi.id}`, {
      method: "DELETE"
    });
    setBusyId(null);
    if (ok) {
      setMsg({ kind: "ok", text: "ลบเกณฑ์เรียบร้อย" });
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-slate-500">
          {kpis.length} เกณฑ์ · ลำดับใน column &quot;#&quot; กำหนดลำดับที่แสดงในตารางสรุป
        </div>
        <button
          type="button"
          className="btn-primary text-sm py-2 px-4"
          onClick={() => setModal({ mode: "create" })}
        >
          + เพิ่มเกณฑ์ใหม่
        </button>
      </div>

      {msg && (
        <div className={`text-sm text-center ${
          msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
        }`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-left">
              <th className="py-2 pr-2 font-semibold text-slate-600 w-16 text-center">#</th>
              <th className="py-2 pr-3 font-semibold text-slate-600">เกณฑ์</th>
              <th className="py-2 pr-3 font-semibold text-slate-600 w-20">ระดับ</th>
              <th className="py-2 pr-3 font-semibold text-slate-600 w-40">ที่มา</th>
              <th className="py-2 pr-3 font-semibold text-slate-600 text-center w-28">เป้า</th>
              <th className="py-2 pr-3 font-semibold text-slate-600 text-center w-16">น้ำหนัก</th>
              <th className="py-2 pr-2 font-semibold text-slate-600 text-center w-20">สถานะ</th>
              <th className="py-2 pr-2 font-semibold text-slate-600 text-right w-32">จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {kpis.map((k, idx) => (
              <tr key={k.id}
                className={`border-b border-slate-100 last:border-b-0 ${
                  k.active === 0 ? "opacity-60" : ""
                }`}>
                <td className="py-2 pr-2 text-center">
                  <div className="flex flex-col items-center gap-0.5">
                    <button type="button"
                      disabled={idx === 0 || busyId === k.id}
                      onClick={() => reorder(k.id, "up")}
                      className="text-slate-400 hover:text-brand disabled:opacity-30 text-[10px] leading-none px-1">▲</button>
                    <span className="text-slate-400 text-[10px]">{k.display_order}</span>
                    <button type="button"
                      disabled={idx === kpis.length - 1 || busyId === k.id}
                      onClick={() => reorder(k.id, "down")}
                      className="text-slate-400 hover:text-brand disabled:opacity-30 text-[10px] leading-none px-1">▼</button>
                  </div>
                </td>
                <td className="py-2 pr-3">
                  <div className="font-medium text-slate-800">{k.title}</div>
                  {k.description && (
                    <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">
                      {k.description}
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                    k.scope === "branch"
                      ? "bg-blue-100 text-blue-700"
                      : "bg-purple-100 text-purple-700"
                  }`}>
                    {k.scope === "branch" ? "สาขา" : "บริษัท"}
                  </span>
                </td>
                <td className="py-2 pr-3 text-slate-600 text-[11px]">
                  {kindLabelTh(k.kind)}
                </td>
                <td className="py-2 pr-3 text-center font-mono tabular-nums text-slate-700">
                  {k.target_value != null && k.target_op
                    ? `${k.target_op === "lte" ? "≤" : k.target_op === "gte" ? "≥" : "="} ${k.target_value}${k.unit ?? ""}`
                    : "—"}
                </td>
                <td className="py-2 pr-3 text-center text-slate-600 font-mono">
                  ×{k.weight}
                </td>
                <td className="py-2 pr-2 text-center">
                  <button type="button" onClick={() => toggleActive(k)}
                    disabled={busyId === k.id}
                    className={`text-[10px] px-1.5 py-0.5 rounded font-bold cursor-pointer ${
                      k.active === 1
                        ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                        : "bg-slate-200 text-slate-500 hover:bg-slate-300"
                    }`}>
                    {k.active === 1 ? "ใช้งาน" : "ปิด"}
                  </button>
                </td>
                <td className="py-2 pr-2 text-right">
                  <button type="button"
                    onClick={() => setModal({ mode: "edit", kpi: k })}
                    className="text-brand hover:underline text-[11px] mr-2">
                    แก้ไข
                  </button>
                  <button type="button"
                    onClick={() => removeKpi(k)}
                    disabled={busyId === k.id}
                    className="text-rose-600 hover:underline text-[11px]">
                    ลบ
                  </button>
                </td>
              </tr>
            ))}
            {kpis.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-slate-400">
                  ยังไม่มีเกณฑ์ — กดปุ่ม &quot;+ เพิ่มเกณฑ์ใหม่&quot; ด้านบน
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <EditModal
          initial={modal.mode === "edit" ? modal.kpi : null}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            setMsg({ kind: "ok", text: "บันทึกเกณฑ์เรียบร้อย" });
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function EditModal({
  initial,
  onClose,
  onSaved
}: {
  initial: AscendaKpi | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = initial != null;
  const [scope, setScope] = useState<KpiScope>(initial?.scope ?? "branch");
  const [kind, setKind] = useState<KpiKind>(initial?.kind ?? "manual_number");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [unit, setUnit] = useState(initial?.unit ?? "");
  const [targetValue, setTargetValue] = useState(
    initial?.target_value != null ? String(initial.target_value) : ""
  );
  const [targetOp, setTargetOp] = useState<TargetOp | "">(initial?.target_op ?? "lte");
  const [weight, setWeight] = useState(initial?.weight ?? 1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!title.trim()) {
      setErr("กรุณากรอกชื่อเกณฑ์");
      return;
    }
    setBusy(true);
    const body: Record<string, unknown> = {
      scope, kind,
      title: title.trim(),
      description: description.trim() || null,
      unit: unit.trim() || null,
      target_value: targetValue.trim() === "" ? null : Number(targetValue),
      target_op: targetOp || null,
      weight
    };
    if (!isEdit) body.active = 1;
    try {
      const url = isEdit
        ? apiUrl(`/api/admin/ascenda/kpis/${initial!.id}`)
        : apiUrl("/api/admin/ascenda/kpis");
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(j.message || j.error || "บันทึกไม่สำเร็จ");
        return;
      }
      onSaved();
    } catch {
      setErr("เกิดข้อผิดพลาดเครือข่าย");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-2 sm:p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-card max-h-[90vh] overflow-y-auto">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-slate-800">
              {isEdit ? "แก้ไขเกณฑ์" : "เพิ่มเกณฑ์ใหม่"}
            </h2>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
              ✕
            </button>
          </div>

          <div>
            <label className="label">ชื่อเกณฑ์</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)}
              maxLength={200} placeholder="เช่น อัตราการขาด/ลา/มาสาย" />
          </div>

          <div>
            <label className="label">คำอธิบาย (ไม่บังคับ)</label>
            <textarea className="input" rows={2} maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="อธิบายให้ทีมเข้าใจวิธีวัด" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">ระดับ</label>
              <select className="input" value={scope}
                onChange={(e) => setScope(e.target.value as KpiScope)}>
                <option value="branch">สาขา (ประเมินแยกแต่ละสาขา)</option>
                <option value="company">บริษัท (ประเมินรวมทุกสาขา)</option>
              </select>
            </div>
            <div>
              <label className="label">น้ำหนัก</label>
              <input type="number" className="input" inputMode="numeric"
                min={1} max={10} step={1}
                value={weight}
                onChange={(e) => setWeight(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
              <p className="text-[10px] text-slate-400 mt-1">
                1–10 · น้ำหนักสูง = สำคัญกว่าในคะแนนรวม
              </p>
            </div>
          </div>

          <div>
            <label className="label">ที่มาของข้อมูล</label>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as KpiKind)}>
              {KIND_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.kinds.map((k) => (
                    <option key={k} value={k}>{kindLabelTh(k)} — {k}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="text-[10px] text-slate-400 mt-1">
              อัตโนมัติ = ระบบดึงข้อมูลให้เอง · กรอกเอง = แอดมินใส่ค่ารายเดือน
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="label">เงื่อนไข</label>
              <select className="input" value={targetOp}
                onChange={(e) => setTargetOp(e.target.value as TargetOp | "")}>
                <option value="">— ไม่ตั้ง —</option>
                <option value="lte">≤ น้อยกว่าหรือเท่ากับ</option>
                <option value="gte">≥ มากกว่าหรือเท่ากับ</option>
                <option value="eq">= เท่ากับ</option>
              </select>
            </div>
            <div>
              <label className="label">เป้า</label>
              <input type="number" className="input" inputMode="decimal"
                step="0.01"
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                placeholder="0" />
            </div>
            <div>
              <label className="label">หน่วย</label>
              <input className="input" value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="% / ครั้ง / บาท" maxLength={20} />
            </div>
          </div>

          {err && (
            <div className="text-sm text-rose-600 text-center">✗ {err}</div>
          )}

          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              ยกเลิก
            </button>
            <button type="button" onClick={save} disabled={busy}
              className="btn-primary flex-1">
              {busy ? "กำลังบันทึก…" : isEdit ? "บันทึก" : "เพิ่มเกณฑ์"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
