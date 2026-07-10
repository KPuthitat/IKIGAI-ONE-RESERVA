import { getDb } from "@/lib/db";

// DELIVERA self-delivery sales tally (owner 2026-07-10). DELIVERA keeps its OWN
// record of how many bills the shop self-delivered + the amount — kept SEPARATE
// from ACCOUNTA (delivery revenue is already counted in the shift-close total, so
// this is for visibility, not accounting). "Realized" = an order that reached
// delivered/completed (a real sale), excluding cancelled/in-progress.

const REALIZED = "('delivered','completed')";

export type SalesFigure = { bills: number; total: number };
export type DeliveraSalesReport = {
  month: string;                    // YYYY-MM (Bangkok)
  today: SalesFigure;
  monthTotal: SalesFigure;
  byMethod: { cod: SalesFigure; promptpay: SalesFigure };
  days: Array<{ date: string; bills: number; total: number }>;   // realized per Bangkok day
};

function bkkToday(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** Realized DELIVERA sales for a branch in `month` (YYYY-MM, Bangkok). Grouped by
 *  the Bangkok order date. Amounts are the order totals (incl. delivery fee). */
export function deliveraSalesReport(branchId: number, month: string = bkkToday().slice(0, 7)): DeliveraSalesReport {
  const db = getDb();
  const figure = (extraWhere: string, params: unknown[]): SalesFigure => {
    const r = db.prepare(
      `SELECT COUNT(*) AS bills, COALESCE(SUM(total),0) AS total
         FROM delivery_orders
        WHERE branch_id = ? AND status IN ${REALIZED} ${extraWhere}`
    ).get(branchId, ...params) as { bills: number; total: number };
    return { bills: r.bills, total: Math.round(r.total * 100) / 100 };
  };

  const today = bkkToday();
  const monthFig = figure("AND substr(date(created_at,'+7 hours'),1,7) = ?", [month]);
  const todayFig = figure("AND date(created_at,'+7 hours') = ?", [today]);
  const cod = figure("AND substr(date(created_at,'+7 hours'),1,7) = ? AND pay_method = 'cod'", [month]);
  const promptpay = figure("AND substr(date(created_at,'+7 hours'),1,7) = ? AND pay_method = 'promptpay'", [month]);

  const days = db.prepare(
    `SELECT date(created_at,'+7 hours') AS date, COUNT(*) AS bills, COALESCE(SUM(total),0) AS total
       FROM delivery_orders
      WHERE branch_id = ? AND status IN ${REALIZED} AND substr(date(created_at,'+7 hours'),1,7) = ?
      GROUP BY date(created_at,'+7 hours')
      ORDER BY date DESC`
  ).all(branchId, month) as Array<{ date: string; bills: number; total: number }>;

  return {
    month, today: todayFig, monthTotal: monthFig,
    byMethod: { cod, promptpay },
    days: days.map((d) => ({ date: d.date, bills: d.bills, total: Math.round(d.total * 100) / 100 }))
  };
}
