import { getDeliveraChannel } from "@/lib/messaging-channels";

// DELIVERA LINE channel credentials, resolved DB-first then .env fallback.
//
// The owner configures token/secret/LIFF in-app at /admin/delivera/connection
// (stored encrypted in messaging_channels, scope='delivera'). Legacy .env keys
// still work as a fallback so nothing breaks for anyone who set them earlier.
// Server-only (reads the DB) — never import from a client component.

export type DeliveraCreds = { token: string | null; secret: string | null; liffId: string | null };

function pick(dbVal: string | null | undefined, envVal: string | undefined): string | null {
  const v = (dbVal ?? "").trim() || (envVal ?? "").trim();
  return v || null;
}

export function customerCreds(): DeliveraCreds {
  const ch = getDeliveraChannel("customer");
  return {
    token: pick(ch?.channel_token, process.env.LINE_CUSTOMER_CHANNEL_ACCESS_TOKEN),
    secret: pick(ch?.channel_secret, process.env.LINE_CUSTOMER_CHANNEL_SECRET),
    liffId: pick(ch?.liff_id, process.env.NEXT_PUBLIC_LINE_CUSTOMER_LIFF_ID)
  };
}

export function riderCreds(): DeliveraCreds {
  const ch = getDeliveraChannel("rider");
  return {
    token: pick(ch?.channel_token, process.env.LINE_RIDER_CHANNEL_ACCESS_TOKEN),
    secret: pick(ch?.channel_secret, process.env.LINE_RIDER_CHANNEL_SECRET),
    liffId: pick(ch?.liff_id, process.env.NEXT_PUBLIC_LINE_RIDER_LIFF_ID)
  };
}
