"use client";

// Branch-level config for the three default money fields on the
// shift_close report. Shown above the per-item checklist editor
// when ?type=shift_close. Each field carries three knobs:
//
//   • in_red_box  — render in the prominent red headline box
//                   (off → falls into the regular checklist body)
//   • label       — custom wording (empty = use the default Thai
//                   label "ยอดเงินปิดงาน" / "เซอร์วิสชาร์จวันนี้" /
//                   "ยอดขายวันนี้")
//   • display_order — small ↑ ↓ buttons to reorder among the three
//
// Wired to POST /api/admin/persona/shift-close-defaults — the
// route updates the operator's currently-active branch row.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type FieldKey = "closing_drawer" | "service_charge" | "daily_revenue";

type FieldState = {
  key: FieldKey;
  defaultLabel: string;
  hint: string;
  in_red_box: boolean;
  label: string;            // empty string = fall back to defaultLabel
  display_order: number;
};

export default function ShiftCloseDefaultsToggle({
  initial
}: {
  initial: {
    closing_drawer: { in_red_box: boolean; label: string | null; display_order: number };
    service_charge: { in_red_box: boolean; label: string | null; display_order: number };
    daily_revenue:  { in_red_box: boolean; label: string | null; display_order: number };
  };
}) {
  const router = useRouter();

  const buildInitial = (): FieldState[] => ([
    {
      key: "closing_drawer",
      defaultLabel: "ยอดเงินปิดงาน",
      hint: "เงินสด + e-wallet + อื่นๆ ที่ปิดยอดท้ายวัน",
      in_red_box: initial.closing_drawer.in_red_box,
      label: initial.closing_drawer.label ?? "",
      display_order: initial.closing_drawer.display_order
    },
    {
      key: "service_charge",
      defaultLabel: "เซอร์วิสชาร์จวันนี้",
      hint: "ยอด SVC ของวันนี้ก่อนหารแบ่ง",
      in_red_box: initial.service_charge.in_red_box,
      label: initial.service_charge.label ?? "",
      display_order: initial.service_charge.display_order
    },
    {
      key: "daily_revenue",
      defaultLabel: "ยอดขายวันนี้",
      hint: "ASCENDA daily revenue ยอดขายรวมจากระบบ POS",
      in_red_box: initial.daily_revenue.in_red_box,
      label: initial.daily_revenue.label ?? "",
      display_order: initial.daily_revenue.display_order
    }
  ]);

  const [fields, setFields] = useState<FieldState[]>(buildInitial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Order-sorted view for rendering. We keep the underlying array
  // in insertion order so React keys stay stable across renders;
  // the displayed list is recomputed on every render.
  const ordered = useMemo(
    () => [...fields].sort((a, b) => a.display_order - b.display_order),
    [fields]
  );

  // Track "dirty" against the original initial values so the save
  // button only lights up when something actually changed.
  const dirty = useMemo(() => {
    const original = buildInitial();
    return fields.some((f, i) => {
      const o = original.find((x) => x.key === f.key)!;
      return o.in_red_box !== f.in_red_box
          || (o.label || "") !== (f.label || "")
          || o.display_order !== f.display_order;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields]);

  function patchField(key: FieldKey, patch: Partial<FieldState>) {
    setFields((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  }

  function swapOrder(keyA: FieldKey, keyB: FieldKey) {
    setFields((prev) => {
      const a = prev.find((f) => f.key === keyA)!;
      const b = prev.find((f) => f.key === keyB)!;
      return prev.map((f) => {
        if (f.key === keyA) return { ...f, display_order: b.display_order };
        if (f.key === keyB) return { ...f, display_order: a.display_order };
        return f;
      });
    });
  }

  function moveUp(key: FieldKey) {
    const idx = ordered.findIndex((f) => f.key === key);
    if (idx <= 0) return;
    swapOrder(key, ordered[idx - 1].key);
  }
  function moveDown(key: FieldKey) {
    const idx = ordered.findIndex((f) => f.key === key);
    if (idx === -1 || idx === ordered.length - 1) return;
    swapOrder(key, ordered[idx + 1].key);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const body = Object.fromEntries(
        fields.map((f) => [
          f.key,
          {
            in_red_box: f.in_red_box,
            label: f.label.trim() === "" ? null : f.label.trim(),
            display_order: f.display_order
          }
        ])
      );
      const res = await fetch(apiUrl("/api/admin/persona/shift-close-defaults"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        setMsg("บันทึกไม่สำเร็จ ลองอีกครั้ง");
        return;
      }
      setMsg("✓ บันทึกแล้ว");
      router.refresh();
      setTimeout(() => setMsg(null), 2200);
    } catch {
      setMsg("เครือข่ายมีปัญหา ลองอีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="text-sm font-bold text-slate-800">
          🎯 ตัวเลขเด่นในกรอบแดง · เปลี่ยนชื่อ · เลื่อนลำดับ
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          ติ๊ก = แสดงในกรอบแดงด้านบน · กล่องชื่อปล่อยว่าง = ใช้คำตั้งต้น
          · กดลูกศร ↑↓ เพื่อเลื่อนลำดับการแสดงผล (อันบนสุดเป็นตัวใหญ่ที่สุดในการ์ด)
        </p>
      </div>

      <div className="space-y-2">
        {ordered.map((f, idx) => (
          <div
            key={f.key}
            className={`rounded-lg border p-3 ${
              f.in_red_box
                ? "border-rose-300 bg-rose-50/40"
                : "border-slate-200 bg-slate-50"
            }`}
          >
            <div className="flex items-start gap-2">
              {/* Order controls */}
              <div className="flex flex-col gap-0.5 flex-shrink-0 pt-0.5">
                <button
                  type="button"
                  onClick={() => moveUp(f.key)}
                  disabled={idx === 0}
                  className="text-slate-400 hover:text-slate-700 disabled:opacity-20 text-xs leading-none p-0.5"
                  aria-label="เลื่อนขึ้น"
                  title="เลื่อนขึ้น"
                >▲</button>
                <span className="text-[9px] font-mono text-slate-400 text-center">
                  {idx + 1}
                </span>
                <button
                  type="button"
                  onClick={() => moveDown(f.key)}
                  disabled={idx === ordered.length - 1}
                  className="text-slate-400 hover:text-slate-700 disabled:opacity-20 text-xs leading-none p-0.5"
                  aria-label="เลื่อนลง"
                  title="เลื่อนลง"
                >▼</button>
              </div>

              {/* Checkbox + content */}
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 flex-shrink-0"
                checked={f.in_red_box}
                onChange={(e) => patchField(f.key, { in_red_box: e.target.checked })}
              />
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    className="input text-sm flex-1"
                    placeholder={f.defaultLabel}
                    maxLength={60}
                    value={f.label}
                    onChange={(e) => patchField(f.key, { label: e.target.value })}
                  />
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-bold flex-shrink-0 ${
                      f.in_red_box
                        ? "bg-rose-500 text-white"
                        : "bg-slate-200 text-slate-500"
                    }`}
                  >
                    {f.in_red_box ? "กรอบแดง" : "ปกติ"}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500">{f.hint}</div>
                {f.label.trim() === "" && (
                  <div className="text-[10px] text-slate-400">
                    ใช้คำตั้งต้น: <span className="font-mono">{f.defaultLabel}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 justify-end">
        {msg && (
          <span className="text-xs text-slate-500 mr-auto">{msg}</span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="btn-primary text-sm disabled:opacity-50"
        >
          {busy ? "กำลังบันทึก..." : dirty ? "บันทึก" : "บันทึกแล้ว"}
        </button>
      </div>
    </div>
  );
}
