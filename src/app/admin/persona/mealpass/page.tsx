import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { bkkDateIso } from "@/lib/time";
import { getMealpassConfig, menuPopularity, ymOf, crossCompanySettlementByMonth, type MenuPopularityRow, type CompanySettlement } from "@/lib/mealpass";
import MealpassConfirmClient, { type PendingOrder } from "./MealpassConfirmClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · ยืนยัน MEALPASS" };

const NAVY = "#0B1F3A";
const GOLD = "#C9A227";

function PopularityCard({ title, hint, rows }: { title: string; hint: string; rows: MenuPopularityRow[] }) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  const top = rows[0]?.count ?? 0;
  return (
    <div className="card space-y-2">
      <div>
        <div className="font-semibold" style={{ color: NAVY }}>{title}</div>
        <div className="text-xs text-slate-400">{hint}</div>
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-slate-400">ยังไม่มีข้อมูลเดือนนี้</div>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r, i) => (
            <li key={`${r.menuItemId ?? "x"}-${i}`} className="text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-slate-700">
                  <span className="text-slate-400 mr-1">{i + 1}.</span>{r.menuName}
                </span>
                <span className="font-mono font-semibold shrink-0" style={{ color: NAVY }}>{r.count}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${top > 0 ? (r.count / top) * 100 : 0}%`, background: GOLD }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="text-xs text-slate-400 pt-1">รวม {total} ครั้ง</div>
    </div>
  );
}

export default function MealpassConfirmPage() {
  const user = requireAdmin();
  const today = bkkDateIso(new Date().toISOString());
  const branchId = user.activeBranchId ?? null;

  const pending: PendingOrder[] = branchId != null
    ? (getDb().prepare(`
        SELECT o.code AS code, u.display_name AS staffName, o.menu_name_snap AS menuName,
               o.meal_class AS mealClass, o.credits AS credits, o.baht AS baht
        FROM mealpass_orders o JOIN users u ON u.id = o.user_id
        WHERE o.branch_id = ? AND o.order_date = ? AND o.kind = 'meal' AND o.status = 'pending'
        ORDER BY o.id ASC`).all(branchId, today) as PendingOrder[])
    : [];

  const ym = ymOf(today);
  const popular = branchId != null ? menuPopularity(branchId, ym) : null;
  const settlement: CompanySettlement[] = crossCompanySettlementByMonth(ym);
  const fmtDay = (iso: string) => new Date(`${iso}T00:00:00`).getDate();
  // Build the พ.ศ. label from ym directly (no ICU dependency, matches the filter).
  const TH_MONTHS = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
    "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
  const [ymY, ymM] = ym.split("-").map(Number);
  const monthLabel = `${TH_MONTHS[ymM - 1]} ${ymY + 543}`;

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">← กลับ PERSONA</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">ยืนยันสิทธิ์ MEALPASS</h1>
        <p className="text-sm text-slate-500 mt-1">สแกน QR หรือกรอกรหัสของพนักงาน — อาหาร (MP) / เครื่องดื่มในร้าน (DR)</p>
      </div>
      {branchId == null
        ? <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน</div>
        : <MealpassConfirmClient pending={pending} config={getMealpassConfig(branchId)} />}

      {branchId != null && popular && (
        <div className="space-y-2">
          <div className="text-sm font-semibold" style={{ color: NAVY }}>เมนูยอดนิยม · {monthLabel}</div>
          <div className="grid gap-3 md:grid-cols-3">
            <PopularityCard title="อาหาร" hint="มื้อที่ยืนยันแล้ว (รวมจ่ายเงินสด)" rows={popular.meals} />
            <PopularityCard title="เครื่องดื่มในร้าน" hint="นับจากคูปองที่ใช้แล้ว" rows={popular.drinks} />
            <PopularityCard title="ข้ามบริษัท (ศาลาชิลล์)" hint="นับจากรายการที่ยืนยันแล้ว" rows={popular.crossCompany} />
          </div>
        </div>
      )}

      {settlement.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold" style={{ color: NAVY }}>ยอดค้างจ่ายข้ามบริษัท · {monthLabel}</div>
          <div className="text-xs text-slate-400">บริษัทต้องชำระให้ผู้ขายตามรอบสัปดาห์ (นับจากมื้อที่ยืนยันแล้ว)</div>
          <div className="grid gap-3 md:grid-cols-2">
            {settlement.map((s) => (
              <div key={s.sellingCompanyId} className="card space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-semibold" style={{ color: NAVY }}>{s.sellingCompanyName ?? `บริษัท #${s.sellingCompanyId}`}</div>
                  <div className="font-mono font-bold" style={{ color: GOLD }}>฿{s.monthTotal.toLocaleString()}</div>
                </div>
                <ul className="space-y-1 text-sm">
                  {s.weeks.map((w) => (
                    <li key={w.weekStart} className="flex items-center justify-between text-slate-600">
                      <span>สัปดาห์ {fmtDay(w.start)}–{fmtDay(w.end)} · {w.count} มื้อ</span>
                      <span className="font-mono">฿{w.total.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
                <div className="text-xs text-slate-400 pt-1">รวมทั้งเดือน {s.monthCount} มื้อ</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
