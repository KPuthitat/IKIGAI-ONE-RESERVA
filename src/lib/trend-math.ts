// Pure helpers for trend charts (no DB) so client components can import them.

/** Trailing moving average (window n) over a series, ignoring missing points; null until a point has data. */
export function movingAverage(values: Array<number | null>, n: number): Array<number | null> {
  return values.map((_, i) => {
    const w = values.slice(Math.max(0, i - n + 1), i + 1).filter((v): v is number => v != null);
    return w.length === 0 ? null : Math.round((w.reduce((s, v) => s + v, 0) / w.length) * 100) / 100;
  });
}
