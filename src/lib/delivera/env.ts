import { z } from "zod";

// DELIVERA environment (owner 2026-07-02).
//
// Validated LAZILY, not at process boot. The module ships behind a per-branch
// `delivera_enabled` flag and its external deps (2 LINE channels, SlipOK,
// Google Maps) are provisioned separately — so a hard boot-time check would
// crash the whole app before the keys exist. Instead each subsystem checks its
// own readiness (customerLineReady/riderLineReady/slipOkReady) and `deliveraEnv`
// throws a clear, specific error only when a code path truly needs a value.
// ASSUMPTION: lazy validation is preferred over crashing boot for a dark-shipped
// module — matches how OCR (ANTHROPIC_API_KEY) is treated in this repo.

const schema = z.object({
  LINE_CUSTOMER_CHANNEL_ACCESS_TOKEN: z.string().min(1),
  LINE_CUSTOMER_CHANNEL_SECRET: z.string().min(1),
  NEXT_PUBLIC_LINE_CUSTOMER_LIFF_ID: z.string().min(1),
  LINE_RIDER_CHANNEL_ACCESS_TOKEN: z.string().min(1),
  LINE_RIDER_CHANNEL_SECRET: z.string().min(1),
  NEXT_PUBLIC_LINE_RIDER_LIFF_ID: z.string().min(1),
  SLIPOK_API_KEY: z.string().min(1),
  SLIPOK_BRANCH_ID: z.string().min(1),
  GOOGLE_MAPS_API_KEY: z.string().optional(), // optional — Haversine works without it
  DELIVERA_HMAC_SECRET: z.string().min(1)
});

export type DeliveraEnv = z.infer<typeof schema>;

let cached: DeliveraEnv | null = null;

/** Full DELIVERA env — throws a specific error listing the missing keys.
 *  Call only from a code path that genuinely needs the config. */
export function deliveraEnv(): DeliveraEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`DELIVERA env not configured: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

export function deliveraConfigured(): boolean {
  return schema.safeParse(process.env).success;
}

// Per-subsystem readiness — lets one part work while another is still dark.
export function customerLineReady(): boolean {
  return Boolean(process.env.LINE_CUSTOMER_CHANNEL_ACCESS_TOKEN && process.env.LINE_CUSTOMER_CHANNEL_SECRET);
}
export function riderLineReady(): boolean {
  return Boolean(process.env.LINE_RIDER_CHANNEL_ACCESS_TOKEN && process.env.LINE_RIDER_CHANNEL_SECRET);
}
export function slipOkReady(): boolean {
  return Boolean(process.env.SLIPOK_API_KEY && process.env.SLIPOK_BRANCH_ID);
}
export function hmacSecret(): string {
  const s = process.env.DELIVERA_HMAC_SECRET;
  if (!s) throw new Error("DELIVERA env not configured: DELIVERA_HMAC_SECRET");
  return s;
}
