// FEASIBILITY — pure calculation engine for the project-feasibility module
// (owner 2026-06-16, spec FEASIBILITY-MODULE-PROMPT). No I/O, no framework —
// just the P&L / decision / sweet-spot math so it can be unit-tested and the
// UI can recompute live. Mirrors the Restaurant Feasibility (Torpenguin)
// template with the corrections noted in the spec (§4):
//   • all 3 scenarios share ONE cost set; only the revenue assumptions vary
//   • break-even uses that scenario's own fixed cost
//   • ROI/year = profit × 12 ÷ startup (annualised)
//   • all figures are PRE corporate-income-tax
//
// All amounts are baht/month unless noted; percentages are stored as whole
// numbers (e.g. 20 = 20%) and divided by 100 here.

export type ScenarioTriple = { base: number; best: number; worst: number };
export type Scenario = "base" | "best" | "worst";

// Client-safe constants/types (kept here, NOT in feasibility-db, so client
// components can import them without pulling in better-sqlite3).
export const FEASIBILITY_COMPANIES = ["WELTRADE", "MEDIHEALTH", "OMNIA"] as const;
export type FeasibilityCompany = (typeof FEASIBILITY_COMPANIES)[number];
export type FeasibilityStatus = "draft" | "active" | "archived";

export type FeasibilityInputs = {
  assumptions: {
    seats: number; occupancyPct: number;
    avgCheckSitin: number; cogsSitinPct: number;
    avgCheckDelivery: number; cogsDeliveryPct: number;
    weekdayDays: number; weekendDays: number;
    turnoverWeekday: ScenarioTriple; turnoverWeekend: ScenarioTriple;
    deliveryWeekday: ScenarioTriple; deliveryWeekend: ScenarioTriple;
  };
  startup: {
    construction: number; ffe: number; stock: number; hardOther: number;
    franchise: number; deposit: number; permit: number; professional: number;
    preOpening: number; softOther: number;
  };
  variablePct: {
    royalty: number; service: number; mgmt: number; marketing: number;
    repair: number; contingency: number; gpDelivery: number;
    partTimeFixed: number; // baht/month, not a %, despite the group name
  };
  fixed: {
    rent: number; staff: number; dishwash: number; utilities: number;
    telephone: number; pos: number; loan: number; propertyTaxPct: number;
  };
  thresholds: { paybackMonths: number; roiPct: number; mosPct: number };
};

/** A brand-new project starts entirely blank — every input 0 EXCEPT the
 *  decision thresholds, which are policy defaults, not project data (§3). */
export function blankInputs(): FeasibilityInputs {
  const triple = (): ScenarioTriple => ({ base: 0, best: 0, worst: 0 });
  return {
    assumptions: {
      seats: 0, occupancyPct: 0,
      avgCheckSitin: 0, cogsSitinPct: 0,
      avgCheckDelivery: 0, cogsDeliveryPct: 0,
      weekdayDays: 0, weekendDays: 0,
      turnoverWeekday: triple(), turnoverWeekend: triple(),
      deliveryWeekday: triple(), deliveryWeekend: triple()
    },
    startup: {
      construction: 0, ffe: 0, stock: 0, hardOther: 0,
      franchise: 0, deposit: 0, permit: 0, professional: 0,
      preOpening: 0, softOther: 0
    },
    variablePct: {
      royalty: 0, service: 0, mgmt: 0, marketing: 0,
      repair: 0, contingency: 0, gpDelivery: 0, partTimeFixed: 0
    },
    fixed: {
      rent: 0, staff: 0, dishwash: 0, utilities: 0,
      telephone: 0, pos: 0, loan: 0, propertyTaxPct: 0
    },
    thresholds: { paybackMonths: 36, roiPct: 20, mosPct: 20 }
  };
}

const n = (x: unknown): number => {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
};

/** Merge an arbitrary (possibly partial/untrusted) object over the blank
 *  default so every key exists + is the right type. Used when reading a
 *  stored blob or accepting an API body — never trust the shape. */
export function coerceInputs(raw: unknown): FeasibilityInputs {
  const blank = blankInputs();
  if (!raw || typeof raw !== "object") return blank;
  const p = raw as Record<string, Record<string, unknown>>;
  const triple = (t: unknown, d: ScenarioTriple): ScenarioTriple => {
    const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
    return { base: n(o.base ?? d.base), best: n(o.best ?? d.best), worst: n(o.worst ?? d.worst) };
  };
  const num = <T extends Record<string, number>>(src: unknown, def: T): T => {
    const o = (src && typeof src === "object" ? src : {}) as Record<string, unknown>;
    const out = {} as Record<string, number>;
    for (const k of Object.keys(def)) out[k] = n(o[k] ?? def[k]);
    return out as T;
  };
  const a = (p.assumptions ?? {}) as Record<string, unknown>;
  return {
    assumptions: {
      ...num(a, {
        seats: 0, occupancyPct: 0, avgCheckSitin: 0, cogsSitinPct: 0,
        avgCheckDelivery: 0, cogsDeliveryPct: 0, weekdayDays: 0, weekendDays: 0
      }),
      turnoverWeekday: triple(a.turnoverWeekday, blank.assumptions.turnoverWeekday),
      turnoverWeekend: triple(a.turnoverWeekend, blank.assumptions.turnoverWeekend),
      deliveryWeekday: triple(a.deliveryWeekday, blank.assumptions.deliveryWeekday),
      deliveryWeekend: triple(a.deliveryWeekend, blank.assumptions.deliveryWeekend)
    },
    startup: num(p.startup, blank.startup),
    variablePct: num(p.variablePct, blank.variablePct),
    fixed: num(p.fixed, blank.fixed),
    thresholds: num(p.thresholds, blank.thresholds)
  };
}

/** Total one-off startup investment. */
export function startupTotal(inp: FeasibilityInputs): number {
  const s = inp.startup;
  return n(s.construction) + n(s.ffe) + n(s.stock) + n(s.hardOther)
    + n(s.franchise) + n(s.deposit) + n(s.permit) + n(s.professional)
    + n(s.preOpening) + n(s.softOther);
}

/** All-Risks insurance premium — NOT an input; derived = startup / 400 / 12
 *  (a flat ~0.25%/yr of asset value, billed monthly) per the template. */
export function insurance(inp: FeasibilityInputs): number {
  return startupTotal(inp) / 400 / 12;
}

/** Combined fixed cost / month — the same for every scenario. */
export function fixedTotal(inp: FeasibilityInputs): number {
  const f = inp.fixed;
  const propertyTax = n(f.rent) * (n(f.propertyTaxPct) / 100);
  return n(f.rent) + n(f.staff) + n(f.dishwash) + n(f.utilities)
    + n(f.telephone) + n(f.pos) + n(f.loan) + propertyTax + insurance(inp);
}

/** Combined variable rate as a fraction of sales (royalty + service + mgmt +
 *  marketing + repair + contingency). gpDelivery + partTimeFixed are applied
 *  separately in the P&L. */
export function variableRate(inp: FeasibilityInputs): number {
  const v = inp.variablePct;
  return (n(v.royalty) + n(v.service) + n(v.mgmt) + n(v.marketing)
    + n(v.repair) + n(v.contingency)) / 100;
}

export type PnlResult = {
  sales: number; sitSales: number; delSales: number;
  cogs: number; grossProfit: number;
  variable: number; fixed: number; totalCost: number;
  profit: number; cmr: number;
  breakevenBaht: number; breakevenUnits: number; breakevenPerDay: number;
  paybackMonths: number; roiAnnual: number; marginOfSafety: number;
};

/** Compute the monthly P&L for one scenario. Cost set is shared; only the
 *  scenario's revenue assumptions (table turns + delivery orders) vary. */
export function computeScenario(inp: FeasibilityInputs, scenario: Scenario): PnlResult {
  const a = inp.assumptions;
  const twd = n(a.turnoverWeekday[scenario]);
  const twe = n(a.turnoverWeekend[scenario]);
  const dwd = n(a.deliveryWeekday[scenario]);
  const dwe = n(a.deliveryWeekend[scenario]);

  const occ = n(a.occupancyPct) / 100;
  const sitWdHeads = twd * occ * n(a.seats);
  const sitWeHeads = twe * occ * n(a.seats);
  const sitSales = (sitWdHeads * n(a.weekdayDays) + sitWeHeads * n(a.weekendDays)) * n(a.avgCheckSitin);
  const delSales = (dwd * n(a.weekdayDays) + dwe * n(a.weekendDays)) * n(a.avgCheckDelivery);
  const sales = sitSales + delSales;

  const cogs = sitSales * (n(a.cogsSitinPct) / 100) + delSales * (n(a.cogsDeliveryPct) / 100);
  const grossProfit = sales - cogs;

  const varRate = variableRate(inp);
  const variable = sales * varRate
    + delSales * (n(inp.variablePct.gpDelivery) / 100)
    + n(inp.variablePct.partTimeFixed);
  const fixed = fixedTotal(inp);
  const totalCost = variable + fixed;
  const profit = sales - cogs - totalCost;

  const cmr = 1 - (n(a.cogsSitinPct) / 100) - varRate;
  const breakevenBaht = cmr > 0 ? fixed / cmr : Infinity;
  const breakevenUnits = (n(a.avgCheckSitin) > 0 && cmr > 0)
    ? fixed / (n(a.avgCheckSitin) * cmr) : Infinity;
  const breakevenPerDay = breakevenUnits / Math.max(n(a.weekdayDays) + n(a.weekendDays), 1);

  const start = startupTotal(inp);
  const paybackMonths = profit > 0 ? start / profit : Infinity;
  const roiAnnual = start > 0 ? (profit * 12) / start : 0;
  const marginOfSafety = sales > 0 ? (sales - breakevenBaht) / sales : 0;

  return {
    sales, sitSales, delSales, cogs, grossProfit, variable, fixed, totalCost,
    profit, cmr, breakevenBaht, breakevenUnits, breakevenPerDay,
    paybackMonths, roiAnnual, marginOfSafety
  };
}

export type Verdict = "go" | "caution" | "no";
export type Decision = { verdict: Verdict; label: string; reasons: string[] };

/** Go / No-Go decision from the Base-case P&L + thresholds (§4). */
export function decide(base: PnlResult, thresholds: FeasibilityInputs["thresholds"]): Decision {
  if (!(base.profit > 0)) {
    return { verdict: "no", label: "ไม่ควรลงทุน", reasons: ["ขาดทุน (กำไรต่อเดือน ≤ 0)"] };
  }
  const reasons: string[] = [];
  if (!(base.paybackMonths <= thresholds.paybackMonths)) reasons.push("คืนทุนช้ากว่าเป้า");
  if (!(base.roiAnnual >= thresholds.roiPct / 100)) reasons.push("ROI ต่ำกว่าเกณฑ์");
  if (!(base.marginOfSafety >= thresholds.mosPct / 100)) reasons.push("Margin of Safety บาง");
  if (reasons.length === 0) {
    return { verdict: "go", label: "น่าลงทุน", reasons: [] };
  }
  return { verdict: "caution", label: "ทำได้ แต่มีความเสี่ยง", reasons };
}

export type SweetSpot = {
  floor: number; target: number; comfort: number; ceiling: number;
  /** Convert a monthly-sales figure into the sit-in heads/day it implies. */
  dailyHeads: (sales: number) => number;
};

/** The "comfortable revenue range" — 4 markers on the Base case (§4). */
export function sweetSpot(inp: FeasibilityInputs): SweetSpot {
  const a = inp.assumptions;
  const baseR = computeScenario(inp, "base");
  const bestR = computeScenario(inp, "best");
  const cmr = baseR.cmr;
  const fixed = fixedTotal(inp);
  const start = startupTotal(inp);
  const floor = baseR.breakevenBaht;
  const target = cmr > 0
    ? (start / Math.max(inp.thresholds.paybackMonths, 1) + fixed) / cmr
    : Infinity;
  const totalDays = Math.max(n(a.weekdayDays) + n(a.weekendDays), 1);
  return {
    floor,
    target,
    comfort: baseR.sales,
    ceiling: bestR.sales,
    dailyHeads: (sales: number) =>
      n(a.avgCheckSitin) > 0 ? sales / n(a.avgCheckSitin) / totalDays : 0
  };
}

export type FeasibilityResult = {
  base: PnlResult; best: PnlResult; worst: PnlResult;
  decision: Decision; sweet: SweetSpot;
  startupTotal: number; fixedTotal: number; insurance: number;
};

/** One-call full evaluation used by the result page + the list summary. */
export function evaluate(inp: FeasibilityInputs): FeasibilityResult {
  const base = computeScenario(inp, "base");
  return {
    base,
    best: computeScenario(inp, "best"),
    worst: computeScenario(inp, "worst"),
    decision: decide(base, inp.thresholds),
    sweet: sweetSpot(inp),
    startupTotal: startupTotal(inp),
    fixedTotal: fixedTotal(inp),
    insurance: insurance(inp)
  };
}
