import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { bkkDateIso, formatLongDate } from "@/lib/time";
import { getMealpassConfig, balanceForUser, monthlyEarned, ymOf, getDrinkCouponForDate, resolveHomeCompanyId, hasMealpassConsent } from "@/lib/mealpass";
import OwlMascot from "@/app/components/OwlMascot";
import MealpassClient, { type MealpassMenuItem, type MealpassHistoryRow, type SalaMenuItem } from "./MealpassClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · MEALPASS" };

export default function MealpassPage() {
  const user = requireUser();
  const today = bkkDateIso(new Date().toISOString());
  const ym = ymOf(today);
  const db = getDb();
  const branchId = user.activeBranchId ?? null;

  const branch = branchId != null
    ? (db.prepare(`
        SELECT b.name AS name, c.name_th AS company
        FROM branches b LEFT JOIN companies c ON c.id = b.company_id
        WHERE b.id = ?`).get(branchId) as { name: string; company: string | null } | undefined)
    : undefined;

  const me = db.prepare("SELECT employee_code FROM users WHERE id = ?").get(user.id) as { employee_code: string | null } | undefined;

  const cfg = getMealpassConfig(branchId ?? -1, db);
  const balance = branchId != null ? balanceForUser(user.id, ym, db) : 0;
  const earned = branchId != null ? monthlyEarned(user.id, ym, db) : 0;
  const meals = cfg.standard_credit_cost > 0 ? Math.floor(balance / cfg.standard_credit_cost) : 0;

  // Chip counts — full vs half earn days this month (notes stamped by the engine).
  const earnRows = branchId != null
    ? (db.prepare(
        "SELECT notes, COUNT(*) AS n FROM mealpass_ledger WHERE user_id = ? AND ym = ? AND entry_type = 'earn' GROUP BY notes"
      ).all(user.id, ym) as Array<{ notes: string | null; n: number }>)
    : [];
  const fullDays = earnRows.find((r) => r.notes === "เต็มวัน")?.n ?? 0;
  const halfDays = earnRows.find((r) => r.notes === "ครึ่งวัน")?.n ?? 0;

  // Menu — standard (flagged) + special (other available items). Single source:
  // DELIVERA menu, no duplicate table.
  const menu: MealpassMenuItem[] = branchId != null
    ? (db.prepare(`
        SELECT id, name_th AS name, price, is_standard_meal AS isStandard, credit_cost AS creditCost,
               image_url AS imageUrl, category
        FROM delivera_menu_items
        WHERE branch_id = ? AND is_available = 1
        ORDER BY is_standard_meal DESC, sort_order ASC, id ASC`).all(branchId) as MealpassMenuItem[])
    : [];

  // In-store canned drinks (is_store_drink) + today's free drink coupon.
  const storeDrinks: MealpassMenuItem[] = branchId != null
    ? (db.prepare(`
        SELECT id, name_th AS name, price, is_standard_meal AS isStandard, credit_cost AS creditCost,
               image_url AS imageUrl, category
        FROM delivera_menu_items
        WHERE branch_id = ? AND is_available = 1 AND is_store_drink = 1
        ORDER BY sort_order ASC, id ASC`).all(branchId) as MealpassMenuItem[])
    : [];
  const dc = branchId != null ? getDrinkCouponForDate(user.id, today, db) : null;
  const drinkCoupon = dc
    ? { code: dc.code, status: dc.status, menuName: dc.menu_name_snap }
    : null;

  const history: MealpassHistoryRow[] = branchId != null
    ? (db.prepare(`
        SELECT entry_type AS type, credits, baht, menu_name_snap AS menuName, notes, created_at AS createdAt
        FROM mealpass_ledger WHERE user_id = ? AND ym = ?
        ORDER BY id DESC LIMIT 25`).all(user.id, ym) as MealpassHistoryRow[])
    : [];

  const todayOrder = branchId != null
    ? (db.prepare(`
        SELECT code, menu_name_snap AS menuName, meal_class AS mealClass, credits, baht, status
        FROM mealpass_orders
        WHERE user_id = ? AND order_date = ? AND kind = 'meal' AND status IN ('pending','confirmed')
        ORDER BY id DESC LIMIT 1`).get(user.id, today) as
        { code: string; menuName: string; mealClass: string; credits: number; baht: number; status: string } | undefined)
    : undefined;

  // ── ศาลาชิลล์ (cross-company): menus at OTHER companies' branches. Buying one
  // charges the buyer's payroll; the company settles with the seller weekly. ──
  const homeCompanyId = branchId != null ? resolveHomeCompanyId(user.id, db) : null;
  const salaMenu: SalaMenuItem[] = homeCompanyId != null
    ? (db.prepare(`
        SELECT m.id, m.name_th AS name, m.price, m.image_url AS imageUrl,
               b.id AS branchId, b.name AS branchName, c.name_th AS companyName
        FROM delivera_menu_items m
        JOIN branches b ON b.id = m.branch_id
        LEFT JOIN companies c ON c.id = b.company_id
        WHERE m.is_available = 1 AND b.company_id IS NOT NULL AND b.company_id <> ?
        ORDER BY b.id ASC, m.sort_order ASC, m.id ASC`).all(homeCompanyId) as SalaMenuItem[])
    : [];
  const hasConsent = branchId != null ? hasMealpassConsent(user.id, db) : false;
  const crossOrderRow = branchId != null
    ? (db.prepare(`
        SELECT code, menu_name_snap AS menuName, baht, status
        FROM mealpass_orders
        WHERE user_id = ? AND order_date = ? AND kind = 'cross_company' AND status IN ('pending','confirmed')
        ORDER BY id DESC LIMIT 1`).get(user.id, today) as
        { code: string; menuName: string; baht: number; status: string } | undefined)
    : undefined;

  const dateLabel = `วันที่ ${formatLongDate(today, "th")}`;

  return (
    <div className="space-y-4">
      <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">← กลับหน้าลงเวลา</Link>

      {/* Navy header — น้องฮูก greeting */}
      <div className="rounded-2xl p-5 text-white" style={{ background: "#0B1F3A" }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-extrabold tracking-wide">MEALPASS</span>
              <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: "#C9A227", color: "#0B1F3A" }}>2.0</span>
            </div>
            <div className="mt-2 text-base font-semibold">สวัสดีครับ คุณ{user.display_name}</div>
            <div className="mt-1 text-xs text-white/70">
              {[me?.employee_code, branch?.name, branch?.company ? `สังกัด ${branch.company}` : null]
                .filter(Boolean).join(" · ") || "—"}
            </div>
            <div className="mt-0.5 text-xs text-white/50">{dateLabel}</div>
          </div>
          <OwlMascot size={56} ariaLabel="น้องฮูก" />
        </div>
      </div>

      {branchId == null ? (
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      ) : !cfg.enabled ? (
        <div className="card text-sm text-slate-500">สาขานี้ยังไม่เปิดใช้ MEALPASS</div>
      ) : (
        <MealpassClient
          balance={balance}
          meals={meals}
          earned={earned}
          cap={cfg.monthly_cap}
          standardCost={cfg.standard_credit_cost}
          fullDays={fullDays}
          halfDays={halfDays}
          redeemCutoff={cfg.redeem_cutoff}
          branchName={branch?.name ?? ""}
          menu={menu}
          storeDrinks={storeDrinks}
          drinkCoupon={drinkCoupon}
          history={history}
          todayOrder={todayOrder ?? null}
          salaMenu={salaMenu}
          hasConsent={hasConsent}
          crossOrder={crossOrderRow ?? null}
        />
      )}
    </div>
  );
}
