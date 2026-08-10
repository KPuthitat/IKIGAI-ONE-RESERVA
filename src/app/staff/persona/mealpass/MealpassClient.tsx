"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

const NAVY = "#0B1F3A";
const GOLD = "#C9A227";

export type MealpassMenuItem = {
  id: number;
  name: string;
  price: number;
  isStandard: number;      // 0/1
  creditCost: number;
  imageUrl: string | null;
  category: string | null;
};
export type MealpassHistoryRow = {
  type: string;
  credits: number;
  baht: number;
  menuName: string | null;
  notes: string | null;
  createdAt: string;
};

type Tab = "standard" | "special" | "drink" | "sala" | "history";
const SPECIAL_RATE = 0.5;   // display only — the server is the source of truth

const ERR_TH: Record<string, string> = {
  already_today: "วันนี้ใช้สิทธิ์มื้ออาหารไปแล้ว (1 มื้อ/วัน)",
  dine_in_required: "กรุณายืนยันว่าทานที่ร้านก่อน",
  menu_invalid: "เมนูนี้ใช้สิทธิ์ไม่ได้",
  menu_unavailable: "เมนูนี้ปิดอยู่",
  mealpass_disabled: "สาขานี้ยังไม่เปิดใช้ MEALPASS",
  no_branch: "กรุณาเลือกสาขาก่อน",
  no_coupon: "วันนี้ยังไม่มีคูปองเครื่องดื่ม",
  already_used: "ใช้คูปองเครื่องดื่มวันนี้ไปแล้ว",
};

export default function MealpassClient(props: {
  balance: number;
  meals: number;
  earned: number;
  cap: number;
  standardCost: number;
  fullDays: number;
  halfDays: number;
  redeemCutoff: string;
  branchName: string;
  menu: MealpassMenuItem[];
  storeDrinks: MealpassMenuItem[];
  drinkCoupon: { code: string; status: string; menuName: string | null } | null;
  history: MealpassHistoryRow[];
  todayOrder: { code: string; menuName: string; mealClass: string; credits: number; baht: number; status: string } | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("standard");
  const [picked, setPicked] = useState<MealpassMenuItem | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ code: string; mealClass: string; credits: number; baht: number; menuName: string } | null>(null);
  const [demoAfterCutoff, setDemoAfterCutoff] = useState(false);
  const [drinkBusy, setDrinkBusy] = useState(false);
  const [drinkErr, setDrinkErr] = useState<string | null>(null);
  const [drinkCode, setDrinkCode] = useState<string | null>(props.drinkCoupon?.status === "issued" && props.drinkCoupon?.menuName ? props.drinkCoupon.code : null);

  async function chooseDrink(m: MealpassMenuItem) {
    setDrinkBusy(true); setDrinkErr(null);
    try {
      const res = await fetch(apiUrl("/api/staff/persona/mealpass/drink"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menuItemId: m.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setDrinkErr(j.error || "unknown"); setDrinkBusy(false); return; }
      setDrinkCode(j.code);
      router.refresh();
    } catch { setDrinkErr("unknown"); }
    setDrinkBusy(false);
  }

  const standardMenu = useMemo(() => props.menu.filter((m) => m.isStandard === 1), [props.menu]);
  const specialMenu = useMemo(() => props.menu.filter((m) => m.isStandard !== 1), [props.menu]);
  const pct = props.cap > 0 ? Math.min(100, Math.round((props.earned / props.cap) * 100)) : 0;

  const displayCredits = (m: MealpassMenuItem): number =>
    m.isStandard === 1 ? m.creditCost : Math.round(m.price * SPECIAL_RATE);

  async function submit() {
    if (!picked) return;
    if (!ack) { setErr("dine_in_required"); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/staff/persona/mealpass"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menuItemId: picked.id, dineInAck: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.error || "unknown"); setBusy(false); return; }
      setResult({ ...j.order });
      setPicked(null); setAck(false);
      router.refresh();
    } catch { setErr("unknown"); }
    setBusy(false);
  }

  const alreadyUsed = props.todayOrder != null;

  return (
    <div className="space-y-4">
      {/* Balance card */}
      <div className="card">
        <div className="flex items-end justify-between">
          <div>
            <span className="text-5xl font-extrabold" style={{ color: NAVY }}>{props.balance.toLocaleString()}</span>
            <span className="ml-1 text-slate-500 text-sm">เครดิต</span>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold" style={{ color: GOLD }}>{props.meals} มื้อ</div>
          </div>
        </div>
        <div className="mt-3 h-2 rounded-full bg-slate-100 overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: GOLD }} />
        </div>
        <div className="mt-1 flex justify-between text-xs text-slate-500">
          <span>ได้รับ {props.earned.toLocaleString()} จากการลงเวลาเข้าทำงาน</span>
          <span>เพดาน {props.cap.toLocaleString()}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {props.fullDays > 0 && <Chip>ลงเวลาเต็มวัน {props.fullDays} × 60</Chip>}
          {props.halfDays > 0 && <Chip>ครึ่งวัน {props.halfDays} × 30</Chip>}
          <Chip>หมดอายุสิ้นเดือน</Chip>
          <Chip>ห้ามโอนสิทธิ์</Chip>
        </div>
      </div>

      {/* Demo toggle (mockup) — preview after-cutoff behaviour */}
      <label className="card flex items-center justify-between text-sm cursor-pointer">
        <span className="text-slate-600">🕒 Demo: จำลองเวลาเป็นหลัง {props.redeemCutoff} น.</span>
        <input type="checkbox" checked={demoAfterCutoff} onChange={(e) => setDemoAfterCutoff(e.target.checked)} />
      </label>
      {demoAfterCutoff && (
        <div className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
          หลัง {props.redeemCutoff} น. — การใช้สิทธิ์ต้องให้ผู้จัดการกดอนุมัติ (override) พร้อมเหตุผล
        </div>
      )}

      {/* Today's order banner */}
      {alreadyUsed && (
        <div className="card" style={{ borderColor: GOLD, borderWidth: 1 }}>
          <div className="text-sm font-semibold" style={{ color: NAVY }}>
            มื้อวันนี้: {props.todayOrder!.menuName} · {props.todayOrder!.status === "confirmed" ? "ยืนยันแล้ว ✓" : "รอผู้จัดการยืนยัน"}
          </div>
          <div className="mt-1 text-2xl font-extrabold tracking-widest" style={{ color: GOLD }}>{props.todayOrder!.code}</div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        <TabBtn active={tab === "standard"} onClick={() => setTab("standard")}>🍚 เมนูมาตรฐาน</TabBtn>
        <TabBtn active={tab === "special"} onClick={() => setTab("special")}>⭐ เมนูพิเศษ</TabBtn>
        <TabBtn active={tab === "drink"} onClick={() => setTab("drink")}>🥫 เครื่องดื่มในร้าน</TabBtn>
        <TabBtn active={tab === "sala"} onClick={() => setTab("sala")}>🥤 ศาลาชิลล์</TabBtn>
        <TabBtn active={tab === "history"} onClick={() => setTab("history")}>📜 ประวัติ</TabBtn>
      </div>

      {tab === "standard" && (
        <MenuList
          title={`เมนูมาตรฐาน · หัก ${props.standardCost} เครดิต/มื้อ · ใช้ได้เมื่อลงเวลาเข้าทำงาน`}
          items={standardMenu} branchName={props.branchName} disabled={alreadyUsed}
          displayCredits={displayCredits} onPick={(m) => { setPicked(m); setResult(null); }}
        />
      )}
      {tab === "special" && (
        <MenuList
          title="เมนูพิเศษ · หักเครดิตตามที่ระบุ · ใช้ได้เมื่อลงเวลาเข้าทำงาน"
          items={specialMenu} branchName={props.branchName} disabled={alreadyUsed}
          displayCredits={displayCredits} onPick={(m) => { setPicked(m); setResult(null); }}
        />
      )}
      {tab === "drink" && (
        <div className="space-y-2">
          <div className="text-xs text-slate-500 px-1">คูปองเครื่องดื่มในร้าน · ฟรี 1 แก้ว/วัน · ได้เมื่อลงเวลาเข้าทำงาน</div>
          {props.drinkCoupon == null ? (
            <div className="card text-sm text-slate-400">วันนี้ยังไม่มีคูปอง — ตอกบัตรเข้างานเพื่อรับคูปองเครื่องดื่ม 1 แก้ว</div>
          ) : props.drinkCoupon.status === "redeemed" ? (
            <div className="card text-sm" style={{ color: NAVY }}>ใช้คูปองเครื่องดื่มแล้ววันนี้: <b>{props.drinkCoupon.menuName}</b> ✓</div>
          ) : drinkCode ? (
            <div className="card text-center">
              <div className="text-sm text-slate-500">แสดงรหัสนี้ให้ผู้จัดการ</div>
              <div className="my-2 text-3xl font-extrabold tracking-widest" style={{ color: GOLD }}>{drinkCode}</div>
              <div className="text-xs text-slate-400">เครื่องดื่มในร้าน (ฟรี)</div>
            </div>
          ) : (
            <>
              {drinkErr && <div className="text-sm text-rose-600 px-1">{ERR_TH[drinkErr] ?? "ทำรายการไม่สำเร็จ"}</div>}
              {props.storeDrinks.length === 0 && <div className="card text-sm text-slate-400">ยังไม่มีเครื่องดื่มในร้าน — แจ้งแอดมินให้ติดธงเมนู</div>}
              {props.storeDrinks.map((m) => (
                <div key={m.id} className="card flex items-center gap-3">
                  <div className="w-11 h-11 rounded-lg bg-slate-100 flex items-center justify-center overflow-hidden shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {m.imageUrl ? <img src={m.imageUrl} alt="" className="w-full h-full object-cover" /> : <span>🥫</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-slate-800 truncate">{m.name}</div>
                    <div className="text-xs text-slate-400">จากครัว {props.branchName}</div>
                  </div>
                  <button className="text-xs font-semibold px-3 py-1.5 rounded-full disabled:opacity-40"
                    style={{ background: GOLD, color: NAVY }} disabled={drinkBusy} onClick={() => chooseDrink(m)}>
                    เลือก
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
      {tab === "sala" && (
        <div className="card text-sm text-slate-500">เมนูศาลาชิลล์ (ราคาพนักงานข้ามบริษัท) — เร็วๆ นี้</div>
      )}
      {tab === "history" && (
        <div className="card">
          <div className="text-sm font-semibold mb-2" style={{ color: NAVY }}>ประวัติเดือนนี้</div>
          {props.history.length === 0 ? (
            <div className="text-sm text-slate-400">ยังไม่มีรายการ</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {props.history.map((h, i) => (
                <li key={i} className="py-2 flex items-center justify-between text-sm">
                  <span className="text-slate-600">{historyLabel(h)}</span>
                  <span className={h.credits >= 0 ? "text-emerald-600 font-semibold" : "text-rose-600 font-semibold"}>
                    {h.credits >= 0 ? "+" : ""}{h.credits} เครดิต
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Result modal */}
      {result && (
        <Modal onClose={() => setResult(null)}>
          <div className="text-center">
            <div className="text-sm text-slate-500">แสดงรหัสนี้ให้ผู้จัดการเพื่อยืนยัน</div>
            <div className="my-3 text-4xl font-extrabold tracking-widest" style={{ color: GOLD }}>{result.code}</div>
            <div className="text-sm font-semibold" style={{ color: NAVY }}>{result.menuName}</div>
            <div className="mt-1 text-sm text-slate-600">
              {result.mealClass === "cash"
                ? `ชำระเงินสด ${result.baht.toLocaleString()} บาท (ราคาปกติ ลด 10%)`
                : `หัก ${result.credits} เครดิต`}
            </div>
            <div className="mt-1 text-xs text-slate-400">ทานที่ร้านเท่านั้น</div>
            <button className="btn-primary mt-4 w-full" onClick={() => setResult(null)}>เข้าใจแล้ว</button>
          </div>
        </Modal>
      )}

      {/* Dine-in confirm modal */}
      {picked && (
        <Modal onClose={() => { setPicked(null); setAck(false); setErr(null); }}>
          <div className="text-base font-semibold" style={{ color: NAVY }}>{picked.name}</div>
          <div className="mt-1 text-sm text-slate-600">
            หัก {displayCredits(picked)} เครดิต · ราคาปกติ {picked.price.toLocaleString()} บาท
          </div>
          <label className="mt-4 flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>ยืนยันว่า <b>ทานที่ร้าน</b> ไม่ห่อกลับบ้าน</span>
          </label>
          {err && <div className="mt-3 text-sm text-rose-600">{ERR_TH[err] ?? "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง"}</div>}
          <button className="btn-primary mt-4 w-full disabled:opacity-50" disabled={!ack || busy} onClick={submit}>
            {busy ? "กำลังทำรายการ…" : "ยืนยันใช้สิทธิ์"}
          </button>
        </Modal>
      )}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="text-xs px-2 py-1 rounded-full" style={{ background: "#F3ECD6", color: "#8A6D1B" }}>{children}</span>;
}
function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="text-sm px-3 py-1.5 rounded-full whitespace-nowrap font-medium"
      style={active ? { background: NAVY, color: "#fff" } : { background: "#EEF1F5", color: "#334155" }}>
      {children}
    </button>
  );
}
function MenuList(props: {
  title: string;
  items: MealpassMenuItem[];
  branchName: string;
  disabled: boolean;
  displayCredits: (m: MealpassMenuItem) => number;
  onPick: (m: MealpassMenuItem) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500 px-1">{props.title}</div>
      {props.items.length === 0 && <div className="card text-sm text-slate-400">ยังไม่มีเมนูในหมวดนี้</div>}
      {props.items.map((m) => (
        <div key={m.id} className="card flex items-center gap-3">
          <div className="w-11 h-11 rounded-lg bg-slate-100 flex items-center justify-center overflow-hidden shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {m.imageUrl ? <img src={m.imageUrl} alt="" className="w-full h-full object-cover" /> : <span>🍽️</span>}
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "#F3ECD6", color: "#8A6D1B" }}>
              {m.isStandard === 1 ? "เมนูมาตรฐาน" : "เมนูพิเศษ"}
            </span>
            <div className="mt-1 font-semibold text-slate-800 truncate">{m.name}</div>
            <div className="text-xs text-slate-400">จากครัว {props.branchName}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="font-bold" style={{ color: NAVY }}>{props.displayCredits(m)} เครดิต</div>
            <div className="text-[10px] text-slate-400">ใช้ได้เมื่อลงเวลาเข้าทำงาน</div>
            <button className="mt-1 text-xs font-semibold px-3 py-1 rounded-full disabled:opacity-40"
              style={{ background: GOLD, color: NAVY }} disabled={props.disabled} onClick={() => props.onPick(m)}>
              ใช้สิทธิ์
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}
function historyLabel(h: MealpassHistoryRow): string {
  if (h.type === "earn") return `ลงเวลา ${h.notes ?? ""}`.trim();
  if (h.type === "burn") return h.menuName ?? "ใช้สิทธิ์มื้ออาหาร";
  if (h.type === "expire") return "หมดอายุสิ้นเดือน";
  if (h.type === "clawback") return "ปรับคืน (ออกก่อนเวลา)";
  if (h.type === "payroll_charge") return "ศาลาชิลล์ (หักเงินเดือน)";
  return h.type;
}
