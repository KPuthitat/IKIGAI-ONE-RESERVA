import { z } from "zod";
import type { CreateOrderInput } from "./orders";

// Shared zod bodies + mappers for DELIVERA API routes. Kept in a lib (NOT
// exported from route files) — Next.js route modules may only export handlers.

const latSchema = z.number().gte(-90).lte(90);
const lngSchema = z.number().gte(-180).lte(180);

export const QuoteBody = z.object({
  branch_id: z.number().int().positive(),
  dest_lat: latSchema,
  dest_lng: lngSchema,
  subtotal: z.number().min(0)
});

export const OrderItemBody = z.object({
  menu_item_id: z.number().int().positive(),
  qty: z.number().int().min(1).max(99),
  options_json: z.string().max(2000).optional()
});

export const CreateOrderBody = z.object({
  branch_id: z.number().int().positive(),
  access_token: z.string().min(1),                 // LIFF access token → verified server-side
  customer_display_name: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  fulfillment: z.enum(["delivery", "pickup"]),
  dest_address: z.string().trim().max(500).nullable().optional(),
  dest_lat: latSchema.nullable().optional(),
  dest_lng: lngSchema.nullable().optional(),
  time_slot: z.string().trim().max(60).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  items: z.array(OrderItemBody).min(1).max(50)
});

export const PayBody = z.object({
  access_token: z.string().min(1),                 // LIFF access token → verified server-side
  method: z.enum(["promptpay", "cod"])
});

export const SlipBody = z.object({
  access_token: z.string().min(1),
  slip_data: z.string().max(2000).nullable().optional(),   // QR string decoded from the slip
  slip_image_url: z.string().url().max(1000).nullable().optional()
}).refine((d) => !!(d.slip_data || d.slip_image_url), { message: "slip_required" });

// ─── Rider (commit 6) ────────────────────────────────────────────────────────

export const RiderRegisterBody = z.object({
  access_token: z.string().min(1),
  branch_id: z.number().int().positive(),
  phone: z.string().trim().max(20).nullable().optional(),
  vehicle_type: z.string().trim().max(40).nullable().optional(),
  plate: z.string().trim().max(20).nullable().optional(),
  plate_province: z.string().trim().max(40).nullable().optional()
});

export const RiderHeartbeatBody = z.object({
  access_token: z.string().min(1),
  lat: latSchema,
  lng: lngSchema
});

export const RiderJobActionBody = z.object({
  access_token: z.string().min(1),
  action: z.enum(["accept", "pickup", "deliver", "complete"]),
  proof_photo_url: z.string().url().max(1000).nullable().optional()
});

/** Map a validated body + a server-verified LINE userId into a CreateOrderInput. */
export function toCreateOrderInput(
  d: z.infer<typeof CreateOrderBody>,
  lineUserId: string
): CreateOrderInput {
  return {
    branchId: d.branch_id,
    lineUserId,
    customerDisplayName: d.customer_display_name ?? null,
    phone: d.phone ?? null,
    fulfillment: d.fulfillment,
    destAddress: d.dest_address ?? null,
    destLat: d.dest_lat ?? null,
    destLng: d.dest_lng ?? null,
    timeSlot: d.time_slot ?? null,
    note: d.note ?? null,
    items: d.items.map((i) => ({ menu_item_id: i.menu_item_id, qty: i.qty, options_json: i.options_json }))
  };
}
