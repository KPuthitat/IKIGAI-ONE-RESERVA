"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { MealCouponRow, EligibleMenuItem } from "@/lib/meal-coupons";

export default function CouponsClient({
  coupons, foodMenu, hasBranch, hasDrinkPartner, canOrderDrink
}: {
  coupons: MealCouponRow[];
  foodMenu: EligibleMenuItem[];
  hasBranch: boolean;
  hasDrinkPartner: boolean;
  canOrderDrink: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Record<number, number | "">>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!hasBranch) {
    return <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>;
  }

  // Drinks are no longer coupons (owner 2026-07-31) — show only food coupons here.
  const foodCoupons = coupons.filter((c) => c.type === "food");

  // Food redeem (unchanged) — pick a Delivera menu item.
  async function redeemFood(coupon: MealCouponRow) {
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

      {/* Drinks — standalone, unlimited, self-paid (owner 2026-07-31). */}
      {hasDrinkPartner && <DrinkOrderCard canOrderDrink={canOrderDrink} />}

      {/* Food coupons for today (coupon-gated as before). */}
      {foodCoupons.length === 0 ? (
        <div className="card text-sm text-slate-500">
          วันนี้ยังไม่มีคูปองอาหารกลางวัน — คูปองจะออกให้เมื่อกดเข้างานกะที่มีสิทธิ์ (ลงกะเกิน 8 ชม.)
        </div>
      ) : foodCoupons.map((c) => (
        <div key={c.id} className="card space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="font-bold text-slate-800">อาหารกลางวัน</div>
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
            <div className="text-sm text-slate-600">เบิก: <b className="text-slate-800">{c.redeemed_menu_name}</b></div>
          )}
          {c.effectiveStatus === "expired" && (
            <div className="text-sm text-slate-400">คูปองนี้หมดอายุแล้ว (ไม่ได้ใช้ก่อนเวลาที่กำหนด)</div>
          )}
          {c.effectiveStatus === "issued" && (
            foodMenu.length === 0 ? (
              <div className="text-sm text-slate-400">ยังไม่มีเมนูให้เบิกที่สาขานี้ — แจ้งแอดมินให้ตั้งค่าเมนู</div>
            ) : (
              <div className="space-y-2">
                <select
                  className="input"
                  value={selected[c.id] ?? ""}
                  onChange={(e) => setSelected({ ...selected, [c.id]: e.target.value ? Number(e.target.value) : "" })}
                >
                  <option value="">— เลือกเมนู —</option>
                  {foodMenu.map((m) => (
                    <option key={m.id} value={m.id}>{m.name_th}</option>
                  ))}
                </select>
                <button
                  onClick={() => redeemFood(c)}
                  disabled={busyId === c.id}
                  className="w-full py-2.5 rounded-xl bg-amber-500 text-white text-sm font-bold active:scale-95 transition disabled:opacity-50"
                >
                  {busyId === c.id ? "กำลังเบิก…" : "ยืนยันเบิก"}
                </button>
              </div>
            )
          )}
        </div>
      ))}
    </div>
  );
}

// Drink order — always available once clocked in today (owner 2026-07-31): no
// coupon, unlimited per day, self-paid. Create a one-time token → QR for จ้อจี้ to
// scan; จ้อจี้ picks the tier (50/80) + payment method. The charge locks only on
// scan.
function DrinkOrderCard({ canOrderDrink }: { canOrderDrink: boolean }) {
  const [order, setOrder] = useState<{ token: string; expiresAt: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!order) { setQr(null); return; }
    (async () => {
      const QR = (await import("qrcode")).default;
      const url = await QR.toDataURL(order.token, { width: 320, margin: 1, errorCorrectionLevel: "M" });
      if (alive) setQr(url);
    })();
    return () => { alive = false; };
  }, [order]);

  async function requestQr() {
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/staff/persona/drink-order"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg: Record<string, string> = {
          not_clocked_in: "กดเข้างานวันนี้ก่อน ถึงจะสั่งเครื่องดื่มได้",
          no_partner: "สาขานี้ยังไม่ได้ตั้งค่าพาร์ทเนอร์เครื่องดื่ม",
          no_branch: "กรุณาเลือกสาขาก่อน"
        };
        setErr(msg[j.error as string] ?? "ขอ QR ไม่สำเร็จ ลองใหม่อีกครั้ง");
        setBusy(false);
        return;
      }
      setOrder({ token: j.token, expiresAt: j.expiresAt });
    } catch {
      setErr("ขอ QR ไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
    setBusy(false);
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-bold text-slate-800">เครื่องดื่ม (จ้อจี้)</div>
        <span className="text-xs font-medium rounded-full bg-sky-100 text-sky-700 px-2.5 py-0.5">สั่งได้ไม่จำกัด</span>
      </div>

      {order ? (
        <div className="space-y-3 text-center">
          <div className="text-sm text-slate-600">
            ให้พนักงาน<b className="text-slate-800">จ้อจี้สแกน</b> QR นี้ · จ้อจี้เลือกราคา (50/80) แล้วหักค่าตอบแทน หรือรับเงินสด
          </div>
          {qr
            ? <img src={qr} alt="QR เครื่องดื่มจ้อจี้" className="mx-auto rounded-lg border border-slate-200" width={220} height={220} />
            : <div className="h-[220px] flex items-center justify-center text-slate-400 text-sm">กำลังสร้าง QR…</div>}
          {err && <div className="text-sm text-rose-600">{err}</div>}
          <button
            onClick={() => setOrder(null)}
            className="w-full py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-bold active:scale-95 transition"
          >
            รับแล้ว / สั่งแก้วถัดไป
          </button>
        </div>
      ) : !canOrderDrink ? (
        <div className="text-sm text-amber-600">กดเข้างานวันนี้ก่อน ถึงจะสั่งเครื่องดื่มได้</div>
      ) : (
        <div className="space-y-2">
          <div className="text-sm text-slate-600">
            สั่งได้ตลอด ไม่จำกัดจำนวน · <b>จ่ายเอง</b> (จ้อจี้เลือกราคา · หักค่าตอบแทน หรือเงินสด)
          </div>
          {err && <div className="text-sm text-rose-600">{err}</div>}
          <button
            onClick={requestQr}
            disabled={busy}
            className="w-full py-3 rounded-xl bg-amber-500 text-white text-base font-bold active:scale-95 transition disabled:opacity-50"
          >
            {busy ? "กำลังสร้าง…" : "สร้าง QR เครื่องดื่ม"}
          </button>
        </div>
      )}
    </div>
  );
}
