// Simple in-memory rate limiter — ใช้ป้องกัน brute-force PIN
// ต่อ Next.js process — ถ้ามีหลาย instance ต้องใช้ Redis แทน (เราใช้ instance เดียวอยู่)

type Entry = { count: number; firstAt: number };
const buckets = new Map<string, Entry>();

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterMs: number };

/**
 * เช็คและ consume rate limit
 * @param key — IP หรือ identifier
 * @param maxAttempts — จำนวนครั้งสูงสุดในช่วงเวลา
 * @param windowMs — ช่วงเวลา (ms)
 */
export function rateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  const e = buckets.get(key);
  if (!e || now - e.firstAt > windowMs) {
    buckets.set(key, { count: 1, firstAt: now });
    return { ok: true, remaining: maxAttempts - 1 };
  }
  if (e.count >= maxAttempts) {
    return { ok: false, retryAfterMs: windowMs - (now - e.firstAt) };
  }
  e.count++;
  return { ok: true, remaining: maxAttempts - e.count };
}

/** เคลียร์ entries เก่า — เรียกเป็นระยะ (cron หรือ on-demand) */
export function gcRateLimit(maxAgeMs: number): number {
  const now = Date.now();
  let removed = 0;
  for (const [k, e] of buckets) {
    if (now - e.firstAt > maxAgeMs) {
      buckets.delete(k);
      removed++;
    }
  }
  return removed;
}
