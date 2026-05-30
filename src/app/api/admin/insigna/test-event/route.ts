import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import {
  upsertCustomer,
  syncReservation,
  startVisit,
  addOrders,
  endVisit,
  submitFeedback,
  deleteCustomer,
  type ReservationChannel
} from "@/lib/insigna";

// POST /api/admin/insigna/test-event
//
// Sandbox endpoint that fires synthetic INSIGNA events end-to-end —
// useful for smoke-testing after deploy, demo data for the dashboard,
// and verifying the hash boundary still produces real-looking rows.
//
// Test rows are tagged with `__test__` in insigna_customer_tags so the
// "wipe" action can vacuum them out without touching real customer
// data. The cascade FK chain then drops their reservations, visits,
// orders, feedback, attribution rows in one statement.
//
// super_admin only — this writes pseudonymous rows into prod and we
// don't want a regular admin to pollute the dashboard accidentally.

const Body = z.object({
  kind: z.enum([
    "customer",        // just upsert a test customer
    "reservation",     // + reservation
    "full_visit",      // + visit + orders + endVisit (fires persona/churn/attribution)
    "with_feedback",   // full_visit + feedback row
    "wipe"             // delete all __test__-tagged customers
  ])
});

export const dynamic = "force-dynamic";

const TEST_TAG = "__test__";

/** Synthetic stable hash for a test customer index. Uses HMAC over a
 *  marker string so the value collides with neither real LINE hashes
 *  nor phone hashes (those have "line:" / "phone:" prefixes — see
 *  lib/insigna/hash.ts). We compute it inline rather than going
 *  through the rate-limiter because test events should never count
 *  against real-traffic budgets. */
function testCustomerHash(seed: string): string {
  const salt = (process.env.INSIGNA_SALT ?? "").trim();
  if (salt.length < 32) {
    throw new Error("INSIGNA_SALT must be set before firing test events");
  }
  return crypto
    .createHmac("sha256", salt)
    .update(`__test__:${seed}`)
    .digest("hex");
}

/** Mark a customer row as test data so the wipe action can find it. */
function tagAsTest(customer_hash: string): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO insigna_customer_tags
      (customer_hash, tag, source, confidence)
    VALUES (?, ?, 'DERIVED', 1.0)
  `).run(customer_hash, TEST_TAG);
}

const CHANNELS: ReservationChannel[] = ["LINE", "WALKIN", "PHONE", "PARTNER"];
const PARTY_TYPES = ["SOLO", "COUPLE", "FAMILY", "FRIENDS", "BUSINESS"] as const;
const TABLE_ZONES = ["INDOOR", "OUTDOOR", "WINDOW"] as const;
const MENU_CATEGORIES = ["MAIN", "APPETIZER", "DRINK", "DESSERT"] as const;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomMenuItem(): {
  menu_id: string;
  menu_name: string;
  category: typeof MENU_CATEGORIES[number];
  quantity: number;
  unit_price: number;
} {
  const items: Array<{ id: string; name: string; cat: typeof MENU_CATEGORIES[number]; price: number }> = [
    { id: "M001", name: "Carbonara",        cat: "MAIN",      price: 320 },
    { id: "M002", name: "Vongole",          cat: "MAIN",      price: 380 },
    { id: "M003", name: "Bruschetta",       cat: "APPETIZER", price: 180 },
    { id: "M004", name: "Tiramisu",         cat: "DESSERT",   price: 160 },
    { id: "M005", name: "Espresso",         cat: "DRINK",     price: 80 },
    { id: "M006", name: "Pizza Margherita", cat: "MAIN",      price: 290 }
  ];
  const it = pick(items);
  return {
    menu_id: it.id,
    menu_name: it.name,
    category: it.cat,
    quantity: Math.floor(Math.random() * 2) + 1,
    unit_price: it.price
  };
}

export async function POST(req: Request) {
  const user = requireSuperAdmin();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Refuse the whole endpoint if the wall isn't actually active —
  // calling this without INSIGNA_SALT would generate zero usable
  // pseudonyms and clutter the dashboard with nulls.
  if (!process.env.INSIGNA_SALT) {
    return NextResponse.json(
      { error: "salt_missing", message: "ตั้ง INSIGNA_SALT ก่อน แล้วลองอีกครั้ง" },
      { status: 503 }
    );
  }

  // ── WIPE ────────────────────────────────────────────────
  if (parsed.data.kind === "wipe") {
    const db = getDb();
    const hashes = db.prepare(
      "SELECT customer_hash FROM insigna_customer_tags WHERE tag = ?"
    ).all(TEST_TAG) as Array<{ customer_hash: string }>;
    const counts = { customers: 0 };
    for (const h of hashes) {
      try {
        deleteCustomer(h.customer_hash);
        counts.customers += 1;
      } catch (e) {
        console.warn("[insigna-test] wipe one customer failed:", e);
      }
    }
    logPersonaAction(user.id, "insigna.test_wipe", null);
    return NextResponse.json({ ok: true, wiped: counts });
  }

  // ── CREATE / RESERVATION / FULL_VISIT / WITH_FEEDBACK ───
  // Each call mints a NEW test customer (seeded with the current
  // timestamp + a 4-char random suffix) so repeated fires produce
  // distinct rows rather than overwriting the same one.
  const seed = `${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
  const customer_hash = testCustomerHash(seed);

  // Customer always gets created first; later kinds layer onto it.
  upsertCustomer({
    customer_hash,
    birth_year: 1985 + Math.floor(Math.random() * 25),
    gender: pick(["M", "F", "X"]),
    consent_marketing: true,
    consent_analytics: true,
    acquisition_source: pick(["facebook", "google", "line_oa", "walk_in", "referral"])
  });
  tagAsTest(customer_hash);

  if (parsed.data.kind === "customer") {
    logPersonaAction(user.id, "insigna.test_customer", null);
    return NextResponse.json({ ok: true, customer_hash, seed });
  }

  // From here on, also seed a reservation.
  const reservation_id = `TEST-${seed}`;
  const channel = pick(CHANNELS);
  const party_size = Math.floor(Math.random() * 4) + 1;
  const bookedAt = new Date(Date.now() - 86400000).toISOString();   // yesterday
  const scheduledAt = new Date(Date.now()).toISOString();
  syncReservation({
    reservation_id,
    customer_hash,
    booked_at: bookedAt,
    scheduled_at: scheduledAt,
    party_size,
    channel,
    special_occasion: Math.random() > 0.7 ? "birthday" : null
  });

  if (parsed.data.kind === "reservation") {
    logPersonaAction(user.id, "insigna.test_reservation", null);
    return NextResponse.json({ ok: true, customer_hash, reservation_id });
  }

  // full_visit / with_feedback — open a visit + add orders + close.
  // Narrow the literal-string union explicitly so TypeScript can see
  // the value matches PartyType (the pick() return widens to plain
  // string otherwise, even though every element IS a PartyType).
  const party_type: "SOLO" | "COUPLE" | "FAMILY" | "FRIENDS" | "BUSINESS" =
    party_size === 1 ? "SOLO"
    : party_size === 2 ? pick(["COUPLE", "BUSINESS"] as const)
    : party_size >= 5 ? "FAMILY"
    : pick(["FRIENDS", "FAMILY"] as const);
  const { visit_token } = startVisit({
    reservation_id,
    customer_hash,
    party_size,
    party_type,
    table_id: `T${Math.floor(Math.random() * 20) + 1}`,
    table_zone: pick(TABLE_ZONES)
  });

  // 2-4 random order items.
  const orderCount = Math.floor(Math.random() * 3) + 2;
  const items = Array.from({ length: orderCount }, randomMenuItem);
  addOrders(visit_token, items);

  // Close the visit — fires persona + churn + attribution recompute.
  endVisit(visit_token, new Date().toISOString(), "(test event)");

  if (parsed.data.kind === "full_visit") {
    logPersonaAction(user.id, "insigna.test_full_visit", null);
    return NextResponse.json({ ok: true, customer_hash, visit_token, items: orderCount });
  }

  // with_feedback — append a synthetic rating + comment.
  submitFeedback({
    visit_token,
    rating: Math.floor(Math.random() * 2) + 4,        // 4-5 stars (happy customer)
    food_rating: Math.floor(Math.random() * 2) + 4,
    service_rating: Math.floor(Math.random() * 2) + 4,
    ambience_rating: Math.floor(Math.random() * 2) + 4,
    comment: pick([
      "อาหารอร่อยมากค่ะ พนักงานน่ารัก กลับมาอีกแน่",
      "บรรยากาศดี เมนูใหม่ๆ เยอะดี",
      "พาสต้าเด็ดมากครับ ราคาเหมาะกับคุณภาพ",
      null
    ])
  });

  logPersonaAction(user.id, "insigna.test_with_feedback", null);
  return NextResponse.json({
    ok: true,
    customer_hash,
    visit_token,
    items: orderCount,
    feedback: true
  });
}
