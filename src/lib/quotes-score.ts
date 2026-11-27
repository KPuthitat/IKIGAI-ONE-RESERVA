// Pure scoring helpers (no database) so the browser can re-rank live while the weight slider moves.
export const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));
/** Weighted score of a quote: price weight w % and the other benefits (100 − w) %. One decimal. */
export const combinedScore = (priceScore: number, benefitScore: number, weightPrice: number): number => {
  const w = clampPct(weightPrice);
  return Math.round((w * clampPct(priceScore) + (100 - w) * clampPct(benefitScore))) / 100;
};
