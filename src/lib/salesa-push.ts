// REPORTA — "แผนดันยอด" (sales-push planner, owner 2026-09-18). น้องฮูก takes a
// short-horizon target (X days → Y baht for the active branch) and turns the
// branch's own history into a concrete brief the HOD can read to the team:
// how far off normal the target is, how to close the gap (more bills vs bigger
// tickets), which menus to push, what to cross-sell, and which upcoming day to
// hit hardest. Pure compute over the imported POS data; honest when the target
// is out of reach.

import { thaiDate } from "./revshare";
import { listRange, menuRange, receiptItemSets, hasReceiptData } from "./salesa-db";
import { weekdayStats, menuEngineering, beverageMix } from "./salesa-analytics";

const TH_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function round0(n: number): number { return Math.round(n); }
function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }
function baht0(n: number): string { return round0(n).toLocaleString("th-TH"); }

export type PushMenu = { name: string; nett: number };
export type PushPair = { a: string; b: string; count: number };
export type PushDay = { date: string; label: string; weekdayTh: string; expectedNett: number | null };
export type PushVerdict = "no_data" | "easy" | "ontrack" | "stretch" | "hard" | "unrealistic";

export type SalesPushPlan = {
  targetBaht: number;
  days: number;
  fromDate: string;
  toDate: string;
  requiredPerDay: number;
  baselineProjected: number;   // weekday-aware expected nett over the X days
  baselinePerDay: number;
  recentAvgPerDay: number;     // trailing-4-week daily avg (has_sales)
  gap: number;                 // target − baseline (can be negative)
  liftPct: number | null;      // gap / baseline × 100
  hasBaseline: boolean;
  avgTicket: number | null;
  avgBillsPerDay: number | null;
  extraBillsPerDay: number | null;  // bills/day to close the gap via count
  extraTicketBaht: number | null;   // baht/bill to close the gap via ticket
  topEarners: PushMenu[];
  risers: PushMenu[];
  bevPct: number | null;
  bevToFoodPct: number | null;
  crossSell: PushPair[];
  upcoming: PushDay[];         // the X days, chronological, with expected nett
  strongestDate: string | null;
  verdict: PushVerdict;
  verdictText: string;
  advice: string[];            // the HOD brief, ready to read out
};

/** Build the push plan for one branch. `days` (X) and `targetBaht` (Y) come
 *  from the UI; `todayIso` anchors the horizon (today is day 1). */
export function salesPushPlan(branchId: number, targetBaht: number, days: number, todayIso: string): SalesPushPlan {
  const X = Math.max(1, Math.floor(days));
  const fromDate = todayIso;
  const toDate = addDaysIso(todayIso, X - 1);
  const requiredPerDay = round2(targetBaht / X);

  // Trailing 4 weeks (ending yesterday, so today's partial day doesn't skew).
  const trailStart = addDaysIso(todayIso, -28);
  const trailEnd = addDaysIso(todayIso, -1);
  const trailRows = listRange(branchId, trailStart, trailEnd).filter((d) => d.has_sales);
  const trailDays = trailRows.length;
  const trailNett = trailRows.reduce((s, d) => s + d.nett, 0);
  const trailBills = trailRows.reduce((s, d) => s + d.bill_count, 0);
  const recentAvgPerDay = trailDays > 0 ? round2(trailNett / trailDays) : 0;
  const avgBillsPerDay = trailDays > 0 ? round2(trailBills / trailDays) : null;
  const avgTicket = trailBills > 0 ? round2(trailNett / trailBills) : null;
  const hasBaseline = trailDays > 0;

  // Weekday-aware projection: each upcoming day expects its weekday's average
  // (8-week pattern), falling back to the overall recent daily average.
  const wds = weekdayStats(branchId, trailEnd, 56);
  const byDow = new Map<number, number>();
  for (const w of wds) if (w.days > 0) byDow.set(w.dow, w.avgNett);
  const upcoming: PushDay[] = [];
  let baselineProjected = 0;
  for (let i = 0; i < X; i++) {
    const date = addDaysIso(todayIso, i);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const exp = byDow.has(dow) ? byDow.get(dow)! : (hasBaseline ? recentAvgPerDay : null);
    if (exp != null) baselineProjected += exp;
    upcoming.push({ date, label: thaiDate(date), weekdayTh: TH_WEEKDAYS[dow], expectedNett: exp == null ? null : round2(exp) });
  }
  baselineProjected = round2(baselineProjected);
  const baselinePerDay = round2(baselineProjected / X);
  const gap = round2(targetBaht - baselineProjected);
  const liftPct = baselineProjected > 0 ? round2((gap / baselineProjected) * 100) : null;
  const gapPerDay = gap / X;
  const extraBillsPerDay = gap > 0 && avgTicket ? Math.ceil(gapPerDay / avgTicket) : null;
  const extraTicketBaht = gap > 0 && avgBillsPerDay ? round0(gapPerDay / avgBillsPerDay) : null;

  const strongestDate = upcoming.reduce<PushDay | null>(
    (best, d) => (d.expectedNett != null && (best == null || d.expectedNett > (best.expectedNett ?? -1)) ? d : best), null
  )?.date ?? null;

  // What to push: trailing top earners + this month's "stars" (high + rising).
  const topEarners: PushMenu[] = menuRange(branchId, trailStart, trailEnd, "item")
    .slice(0, 5).map((m) => ({ name: m.name, nett: m.nett }));
  const [cy, cm] = todayIso.split("-").map(Number);
  const risers: PushMenu[] = menuEngineering(branchId, cy, cm).stars.slice(0, 3).map((s) => ({ name: s.name, nett: s.nett }));

  // Upsell signal: how thin drinks/dessert attach is (fastest ticket lift).
  const bev = beverageMix(branchId, cy, cm);
  const bevPct = bev.total > 0 ? bev.beveragePct : null;
  const bevToFoodPct = bev.bevToFoodPct;

  // Cross-sell: the pairs most often bought together over the trailing window.
  const crossSell: PushPair[] = [];
  if (hasReceiptData(branchId, trailStart, trailEnd)) {
    const pairCount = new Map<string, number>();
    for (const set of receiptItemSets(branchId, trailStart, trailEnd)) {
      const names = [...new Set(set)].sort();
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        const key = JSON.stringify([names[i], names[j]]);
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
    crossSell.push(...[...pairCount.entries()]
      .map(([k, count]) => { const [a, b] = JSON.parse(k) as [string, string]; return { a, b, count }; })
      .filter((p) => p.count >= 2)
      .sort((x, y) => y.count - x.count)
      .slice(0, 3));
  }

  // Honest verdict by how far above normal the target sits.
  let verdict: PushVerdict;
  let verdictText: string;
  if (!hasBaseline) {
    verdict = "no_data";
    verdictText = "ยังไม่มีข้อมูลยอดขายย้อนหลังพอจะประเมิน — นำเข้าไฟล์ให้ครบก่อน แล้วน้องฮูกจะช่วยวางแผนได้แม่นขึ้น";
  } else if (liftPct == null || liftPct <= 0) {
    verdict = "easy";
    verdictText = `เป้านี้ต่ำกว่ายอดปกติของช่วงนี้ (คาดได้ราว ${baht0(baselineProjected)} บาท) — รักษาระดับการขายไว้ก็ถึงสบายๆ`;
  } else if (liftPct <= 15) {
    verdict = "ontrack";
    verdictText = `ท้าทายกำลังดี ต้องดันเพิ่มจากปกติราว ${liftPct}% — ทำตามแผนด้านล่างมีลุ้นถึงแน่`;
  } else if (liftPct <= 35) {
    verdict = "stretch";
    verdictText = `ต้องเร่งพอสมควร สูงกว่าปกติ ~${liftPct}% — ต้องอัปเซล/ครอสเซลเต็มที่ทุกโต๊ะ + ดันเมนูทำเงิน`;
  } else if (liftPct <= 70) {
    verdict = "hard";
    verdictText = `ยากมาก ต้องทำให้ได้สูงกว่าปกติ ~${liftPct}% ใน ${X} วัน — ต้องมีแคมเปญแรง (โปร/ยิงแอด/ลูกค้าเก่า) ไม่งั้นพลาดสูง`;
  } else {
    verdict = "unrealistic";
    verdictText = `ตรงๆ นะครับ เป้านี้สูงกว่ายอดปกติ ~${liftPct}% ในเวลาแค่ ${X} วัน โอกาสถึงยากมาก — แนะนำปรับเป้าลง หรือขยายจำนวนวัน แล้วค่อยลุยตามแผน`;
  }

  // The brief — HOD reads these out to the team.
  const advice: string[] = [];
  if (hasBaseline) {
    if (gap > 0) {
      advice.push(`เป้า ${X} วัน = ${baht0(targetBaht)} บาท → ต้องได้เฉลี่ยวันละ ${baht0(requiredPerDay)} บาท (ปกติทำได้ราว ${baht0(baselinePerDay)} บาท/วัน ต้องเพิ่มอีก ${liftPct ?? 0}%)`);
      const ways: string[] = [];
      if (extraBillsPerDay != null) ways.push(`เพิ่มลูกค้าอีก ~${baht0(extraBillsPerDay)} บิล/วัน`);
      if (extraTicketBaht != null) ways.push(`หรือดันยอดต่อบิลอีก ~${baht0(extraTicketBaht)} บาท/บิล`);
      if (ways.length) advice.push(`วิธีปิดส่วนต่าง: ${ways.join(" ")}`);
    } else {
      advice.push(`เป้า ${X} วัน = ${baht0(targetBaht)} บาท → เฉลี่ยวันละ ${baht0(requiredPerDay)} บาท ซึ่งต่ำกว่ายอดปกติ (~${baht0(baselinePerDay)} บาท/วัน) รักษาระดับไว้ก็ถึง`);
    }
  }
  if (topEarners.length) advice.push(`ดันเมนูทำเงินหลัก: ${topEarners.slice(0, 3).map((m) => m.name).join(" · ")}`);
  if (risers.length) advice.push(`เมนูมาแรง ดันต่อ: ${risers.map((m) => m.name).join(" · ")}`);
  if (bevToFoodPct != null && bevToFoodPct < 25) advice.push(`เครื่องดื่ม/ของหวานยังน้อย (${bevToFoodPct}% ของยอดอาหาร) → อัปเซลเครื่องดื่มทุกโต๊ะ เป็นวิธีดันยอดต่อหัวที่เร็วสุด`);
  if (crossSell.length) advice.push(`ขายพ่วง: ลูกค้าสั่ง "${crossSell[0].a}" มักสั่ง "${crossSell[0].b}" ด้วย → ให้พนักงานเสนอคู่นี้`);
  if (strongestDate) {
    const sd = upcoming.find((d) => d.date === strongestDate)!;
    advice.push(`วันแรงสุดในช่วงนี้: ${sd.weekdayTh} (${sd.label}) — จัดคน/สต๊อก/โปรเน้นวันนั้นเป็นพิเศษ`);
  }
  if (verdict === "unrealistic" || verdict === "hard") advice.push(verdictText);

  return {
    targetBaht, days: X, fromDate, toDate,
    requiredPerDay, baselineProjected, baselinePerDay, recentAvgPerDay,
    gap, liftPct, hasBaseline,
    avgTicket, avgBillsPerDay, extraBillsPerDay, extraTicketBaht,
    topEarners, risers, bevPct, bevToFoodPct, crossSell,
    upcoming, strongestDate, verdict, verdictText, advice
  };
}
