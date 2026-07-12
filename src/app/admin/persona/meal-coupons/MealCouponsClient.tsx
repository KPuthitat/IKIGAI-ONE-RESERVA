"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { MealCouponConfig, CouponMenuAdminRow } from "@/lib/meal-coupons";

type DeliveraItem = { id: number; name_th: string; category: string | null; is_available: number };

const TYPE_LABEL: Record<"food" | "drink", string> = { food: "อาหารกลางวัน", drink: "เครื่องดื่ม" };

export default function MealCouponsClient({
  config, couponMenu, deliveraMenu, shiftStarts
}: {
  config: MealCouponConfig;
  couponMenu: CouponMenuAdminRow[];
  deliveraMenu: DeliveraItem[];
  shiftStarts: string[];
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(config.enabled);
  const [starts, setStarts] = useState<string[]>(config.eligibleStarts);
  const [cutoff, setCutoff] = useState(config.redeemCutoff);
  const [grace, setGrace] = useState(String(config.graceMin));
  const [savingCfg, setSavingCfg] = useState(false);
  const [addItem, setAddItem] = useState<number | "">("");
  const [addType, setAddType] = useState<"food" | "drink">("food");
  const [err, setErr] = useState<string | null>(null);

  async function post(body: Record<string, unknown>): Promise<boolean> {
    setErr(null);
    const res = await fetch(apiUrl("/api/admin/persona/meal-coupons"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) { setErr("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง"); return false; }
    router.refresh();
    return true;
  }

  async function saveConfig() {
    setSavingCfg(true);
    await post({
      action: "config",
      enabled,
      eligible_starts: starts,
      redeem_cutoff: cutoff,
      late_grace_min: Number(grace) || 0
    });
    setSavingCfg(false);
  }

  const alreadyAdded = new Set(couponMenu.map((m) => m.menu_item_id));
  const addable = deliveraMenu.filter((m) => !alreadyAdded.has(m.id));

  const group = (type: "food" | "drink") => couponMenu.filter((m) => m.type === type);

  return (
    <div className="space-y-4">
      {err && <div className="text-sm text-rose-600">{err}</div>}

      {/* Config */}
      <div className="card space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          เปิดใช้งานคูปองอาหารสำหรับสาขานี้
        </label>

        <div>
          <div className="label">กะที่ได้คูปอง (เลือกเวลาเริ่มกะ)</div>
          {shiftStarts.length === 0 ? (
            <div className="text-xs text-slate-400">สาขานี้ยังไม่มีกะงาน — ตั้งค่ากะที่ตารางเวรก่อน</div>
          ) : (
            <div className="flex flex-wrap gap-3">
              {shiftStarts.map((s) => (
                <label key={s} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={starts.includes(s)}
                    onChange={(e) => setStarts(e.target.checked ? [...starts, s] : starts.filter((x) => x !== s))}
                  /> {s}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <div className="label">ใช้คูปองก่อนเวลา (หมดอายุ)</div>
            <input type="time" className="input" value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
          </div>
          <div>
            <div className="label">กดเข้างานสายได้ไม่เกิน (นาที)</div>
            <input type="number" min={0} max={240} className="input" value={grace} onChange={(e) => setGrace(e.target.value)} />
          </div>
        </div>

        <button onClick={saveConfig} disabled={savingCfg} className="btn-primary disabled:opacity-50">
          {savingCfg ? "กำลังบันทึก…" : "บันทึกการตั้งค่า"}
        </button>
      </div>

      {/* Eligible menu */}
      <div className="card space-y-3">
        <div className="font-bold text-slate-800">เมนูที่เบิกได้ (ดึงจากเมนู Delivera ของสาขานี้)</div>

        {(["food", "drink"] as const).map((type) => (
          <div key={type}>
            <div className="text-sm font-medium text-slate-600 mb-1">{TYPE_LABEL[type]}</div>
            {group(type).length === 0 ? (
              <div className="text-xs text-slate-400 mb-2">ยังไม่ได้เลือกเมนู{TYPE_LABEL[type]}</div>
            ) : (
              <div className="space-y-1 mb-2">
                {group(type).map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-2 text-sm border-b border-slate-50 py-1">
                    <span className={m.active ? "text-slate-700" : "text-slate-400 line-through"}>
                      {m.name_th}{m.is_available ? "" : " (ปิดขายใน Delivera)"}
                    </span>
                    <span className="flex items-center gap-3 shrink-0">
                      <button
                        onClick={() => post({ action: "toggle_menu", id: m.id, active: !m.active })}
                        className="text-xs text-brand"
                      >
                        {m.active ? "ปิด" : "เปิด"}
                      </button>
                      <button
                        onClick={() => post({ action: "remove_menu", id: m.id })}
                        className="text-xs text-rose-600"
                      >
                        ลบ
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Add */}
        <div className="flex flex-wrap items-end gap-2 pt-1 border-t border-slate-100">
          <div className="flex-1 min-w-[10rem]">
            <div className="label">เพิ่มเมนู</div>
            <select className="input" value={addItem} onChange={(e) => setAddItem(e.target.value ? Number(e.target.value) : "")}>
              <option value="">— เลือกเมนูจาก Delivera —</option>
              {addable.map((m) => (
                <option key={m.id} value={m.id}>{m.name_th}{m.category ? ` · ${m.category}` : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="label">เป็น</div>
            <select className="input" value={addType} onChange={(e) => setAddType(e.target.value as "food" | "drink")}>
              <option value="food">อาหารกลางวัน</option>
              <option value="drink">เครื่องดื่ม</option>
            </select>
          </div>
          <button
            onClick={async () => {
              if (!addItem) { setErr("เลือกเมนูก่อน"); return; }
              const ok = await post({ action: "add_menu", menu_item_id: addItem, type: addType });
              if (ok) setAddItem("");
            }}
            className="btn-primary"
          >
            เพิ่ม
          </button>
        </div>
        {addable.length === 0 && deliveraMenu.length === 0 && (
          <div className="text-xs text-slate-400">สาขานี้ยังไม่มีเมนูใน Delivera — เพิ่มเมนูที่ DELIVERA · ตั้งค่า/เมนู ก่อน</div>
        )}
      </div>
    </div>
  );
}
