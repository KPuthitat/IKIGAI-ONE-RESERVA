"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { MealCouponRow, EligibleMenuItem } from "@/lib/meal-coupons";

const TYPE_LABEL: Record<"food" | "drink", string> = {
  food: "อาหารกลางวัน",
  drink: "เครื่องดื่ม"
};

export default function CouponsClient({
  coupons, foodMenu, drinkMenu, hasBranch
}: {
  coupons: MealCouponRow[];
  foodMenu: EligibleMenuItem[];
  drinkMenu: EligibleMenuItem[];
  hasBranch: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Record<number, number | "">>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!hasBranch) {
    return <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>;
  }
  if (coupons.length === 0) {
    return <div className="card text-sm text-slate-500">วันนี้ยังไม่มีคูปอง — คูปองจะออกให้เมื่อกดเข้างานกะ 11:00/12:00</div>;
  }

  const menuFor = (type: "food" | "drink") => (type === "food" ? foodMenu : drinkMenu);

  async function redeem(coupon: MealCouponRow) {
    const menuItemId = selected[coupon.id];
    if (!menuItemId) { setErr("เลือกเมนูก่อนกดเบิก"); return; }
    setErr(null);
    setBusyId(coupon.id);
    try {
      const res = await fetch(apiUrl("/api/staff/persona/meal-coupon/redeem"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ couponId: coupon.id, menuItemId })
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        const msg: Record<string, string> = {
          expired: "คูปองหมดอายุแล้ว",
          already_redeemed: "คูปองนี้ถูกเบิกไปแล้ว",
          menu_invalid: "เมนูนี้เบิกไม่ได้ (อาจถูกปิดไปแล้ว)",
          not_found: "ไม่พบคูปอง",
          no_branch: "กรุณาเลือกสาขาก่อน"
        };
        setErr(msg[j.error as string] ?? "เบิกไม่สำเร็จ ลองใหม่อีกครั้ง");
        setBusyId(null);
        return;
      }
      router.refresh();
    } catch {
      setErr("เบิกไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
    setBusyId(null);
  }

  return (
    <div className="space-y-3">
      {err && <div className="text-sm text-rose-600">{err}</div>}
      {coupons.map((c) => {
        const label = TYPE_LABEL[c.type];
        return (
          <div key={c.id} className="card space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="font-bold text-slate-800">{label}</div>
              {c.effectiveStatus === "redeemed" && (
                <span className="text-xs font-medium rounded-full bg-emerald-100 text-emerald-700 px-2.5 py-0.5">เบิกแล้ว</span>
              )}
              {c.effectiveStatus === "expired" && (
                <span className="text-xs font-medium rounded-full bg-slate-100 text-slate-500 px-2.5 py-0.5">หมดอายุ</span>
              )}
              {c.effectiveStatus === "issued" && (
                <span className="text-xs font-medium rounded-full bg-amber-100 text-amber-700 px-2.5 py-0.5">ใช้ได้</span>
              )}
            </div>

            {c.effectiveStatus === "redeemed" && (
              <div className="text-sm text-slate-600">เบิกเมนู: <b className="text-slate-800">{c.redeemed_menu_name}</b></div>
            )}

            {c.effectiveStatus === "expired" && (
              <div className="text-sm text-slate-400">คูปองนี้หมดอายุแล้ว (ไม่ได้ใช้ก่อนเวลาที่กำหนด)</div>
            )}

            {c.effectiveStatus === "issued" && (
              menuFor(c.type).length === 0 ? (
                <div className="text-sm text-slate-400">ยังไม่มีเมนูให้เบิกที่สาขานี้ — แจ้งแอดมินให้ตั้งค่าเมนู</div>
              ) : (
                <div className="space-y-2">
                  <select
                    className="input"
                    value={selected[c.id] ?? ""}
                    onChange={(e) => setSelected({ ...selected, [c.id]: e.target.value ? Number(e.target.value) : "" })}
                  >
                    <option value="">— เลือกเมนู —</option>
                    {menuFor(c.type).map((m) => (
                      <option key={m.id} value={m.id}>{m.name_th}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => redeem(c)}
                    disabled={busyId === c.id}
                    className="w-full py-2.5 rounded-xl bg-amber-500 text-white text-sm font-bold active:scale-95 transition disabled:opacity-50"
                  >
                    {busyId === c.id ? "กำลังเบิก…" : "ยืนยันเบิก"}
                  </button>
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
