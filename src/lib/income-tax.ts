// INCOME-TAX — pure calculation of Thai SME corporate income tax
// (ภาษีเงินได้นิติบุคคล SME), owner 2026-07-19. No I/O, no framework — so it
// can be unit-tested and reused server-side. Mirrors the pure-calc convention
// of feasibility.ts / revshare.ts.
//
// SME progressive brackets on net taxable profit (กำไรสุทธิ), per Revenue Dept
// rates for a small company (ทุนจดทะเบียนชำระแล้ว ≤5 ล้าน + รายได้ ≤30 ล้าน/ปี):
//   • 0 – 300,000        → 0%
//   • 300,001 – 3,000,000 → 15%
//   • เกิน 3,000,000      → 20%
// Progressive: each slice is taxed at its own rate (not the whole profit at the
// top rate). A loss (netProfit ≤ 0) → no tax.
//
// NOTE: this is a management ESTIMATE only — it does not apply book-to-tax
// adjustments (ค่าเสื่อม, รายการบวกกลับ, ผลขาดทุนยกมา ฯลฯ), so it must never be
// presented as the filed figure. The page that renders it carries a disclaimer.

export type SmeTaxBracket = {
  /** ขอบล่างของขั้น (บาท). */
  from: number;
  /** ขอบบนของขั้น (บาท) — null = ขั้นบนสุดไม่มีเพดาน. */
  to: number | null;
  /** อัตราภาษีของขั้นนี้ (สัดส่วน 0..1). */
  rate: number;
  /** กำไรส่วนที่ตกในขั้นนี้ (บาท). */
  taxable: number;
  /** ภาษีของขั้นนี้ = taxable × rate. */
  tax: number;
};

export type SmeIncomeTax = {
  /** กำไรสุทธิที่นำมาคิด (บาท) — clamp ที่ 0 เมื่อขาดทุน. */
  netProfit: number;
  /** ภาษีประมาณการรวม (บาท). */
  tax: number;
  /** เฉพาะขั้นที่มีกำไรตกถึง (taxable > 0) เพื่อแสดง breakdown. */
  brackets: SmeTaxBracket[];
  /** อัตราภาษีเฉลี่ยที่แท้จริง = tax ÷ netProfit (สัดส่วน 0..1); 0 เมื่อกำไร ≤ 0. */
  effectiveRate: number;
};

/** ขอบเขตขั้นบันได SME — single source of truth. */
export const SME_TAX_BRACKETS: Array<{ from: number; to: number | null; rate: number }> = [
  { from: 0, to: 300_000, rate: 0 },
  { from: 300_000, to: 3_000_000, rate: 0.15 },
  { from: 3_000_000, to: null, rate: 0.20 }
];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** ประมาณการภาษีเงินได้นิติบุคคล SME แบบขั้นบันไดจากกำไรสุทธิ. */
export function smeIncomeTax(netProfit: number): SmeIncomeTax {
  const profit = Number.isFinite(netProfit) ? Math.max(0, netProfit) : 0;
  const brackets: SmeTaxBracket[] = [];
  let tax = 0;
  for (const b of SME_TAX_BRACKETS) {
    const upper = b.to == null ? profit : Math.min(profit, b.to);
    const taxable = Math.max(0, upper - b.from);
    if (taxable <= 0) continue;
    const bracketTax = round2(taxable * b.rate);
    tax += bracketTax;
    brackets.push({ from: b.from, to: b.to, rate: b.rate, taxable: round2(taxable), tax: bracketTax });
  }
  tax = round2(tax);
  return {
    netProfit: round2(profit),
    tax,
    brackets,
    effectiveRate: profit > 0 ? Math.round((tax / profit) * 10000) / 10000 : 0
  };
}
