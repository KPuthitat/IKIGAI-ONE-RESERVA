import { getDb } from "@/lib/db";
import { haversineKm } from "./distance";
import { getOrder, setOrderStatus, OrderError, type OrderRow, type OrderStatus } from "./orders";
import { runOrderHooks } from "./hooks";

// DELIVERA riders (commit 6/8): registration via the IKIGAI RIDER LINE OA,
// live-location heartbeat, distance-based "who's nearby" dispatch, and the
// assign → accept → pick-up → deliver progress track. Branch-scoped by callers.

export type RiderStatus = "offline" | "available" | "busy";

export type RiderRow = {
  id: number; branch_id: number; line_user_id: string; display_name: string;
  phone: string | null; vehicle_type: string | null; plate: string | null; plate_province: string | null;
  status: RiderStatus; is_active: number; is_registered: number;
  last_lat: number | null; last_lng: number | null; last_location_at: string | null;
};

// A rider is "fresh" (usable for nearby dispatch) when its GPS heartbeat is
// within this window — a stale rider might have closed the app / lost signal.
const FRESH_LOCATION_MINUTES = 10;

export function getRiderByLine(lineUserId: string): RiderRow | null {
  return (getDb().prepare("SELECT * FROM riders WHERE line_user_id = ?").get(lineUserId) as RiderRow | undefined) ?? null;
}
export function getRider(id: number): RiderRow | null {
  return (getDb().prepare("SELECT * FROM riders WHERE id = ?").get(id) as RiderRow | undefined) ?? null;
}

/** Register (or update) a rider from the rider LIFF. Keyed by LINE userId. */
export function registerRider(input: {
  branchId: number; lineUserId: string; displayName: string;
  phone?: string | null; vehicleType?: string | null; plate?: string | null;
}): RiderRow {
  const db = getDb();
  const existing = getRiderByLine(input.lineUserId);
  if (existing) {
    db.prepare("UPDATE riders SET branch_id=?, display_name=?, phone=?, vehicle_type=?, plate=?, is_active=1, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(input.branchId, input.displayName, input.phone ?? existing.phone, input.vehicleType ?? existing.vehicle_type, input.plate ?? existing.plate, existing.id);
    return getRider(existing.id)!;
  }
  const info = db.prepare("INSERT INTO riders (branch_id, line_user_id, display_name, phone, vehicle_type, plate, status) VALUES (?,?,?,?,?,?, 'offline')")
    .run(input.branchId, input.lineUserId, input.displayName, input.phone ?? null, input.vehicleType ?? null, input.plate ?? null);
  return getRider(Number(info.lastInsertRowid))!;
}

export function setRiderStatus(riderId: number, status: RiderStatus): void {
  getDb().prepare("UPDATE riders SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, riderId);
}

/** Complete a rider's registration (name + phone + vehicle required). Flips
 *  is_registered → 1 so the rider can go online and be dispatched. */
export function completeRiderRegistration(riderId: number, input: {
  displayName?: string | null; phone: string; vehicleType?: string | null; plate?: string | null; plateProvince?: string | null;
}): RiderRow {
  const cur = getRider(riderId);
  if (!cur) throw new OrderError("rider_not_found", riderId);
  getDb().prepare(
    "UPDATE riders SET display_name=?, phone=?, vehicle_type=?, plate=?, plate_province=?, is_registered=1, is_active=1, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).run(input.displayName?.trim() || cur.display_name, input.phone.trim(),
        input.vehicleType ?? cur.vehicle_type, input.plate ?? cur.plate, input.plateProvince ?? cur.plate_province, riderId);
  return getRider(riderId)!;
}

/** GPS heartbeat from the rider LIFF. Going online while heartbeating flips a
 *  fresh rider to 'available' (unless they're mid-job = busy). */
export function updateRiderLocation(riderId: number, lat: number, lng: number, goOnline = true): void {
  const db = getDb();
  db.prepare("UPDATE riders SET last_lat=?, last_lng=?, last_location_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(lat, lng, riderId);
  if (goOnline) {
    const r = getRider(riderId);
    // Only a registered rider can flip to available (and thus be dispatched).
    if (r && r.is_registered === 1 && r.status === "offline") setRiderStatus(riderId, "available");
  }
}

export type RiderNear = { rider: RiderRow; distanceKm: number | null };

/** Available riders for a branch, nearest-to-the-shop first — "who's nearby".
 *  Distance is from the branch's geofence coords (branches.latitude/longitude);
 *  null when either side has no location. Stale-GPS riders are excluded. */
export function listAvailableRidersNear(branchId: number): RiderNear[] {
  const db = getDb();
  const b = db.prepare("SELECT latitude AS lat, longitude AS lng FROM branches WHERE id = ?").get(branchId) as { lat: number | null; lng: number | null } | undefined;
  const rows = db.prepare(
    `SELECT * FROM riders
      WHERE branch_id = ? AND is_active = 1 AND is_registered = 1 AND status = 'available'
        AND last_location_at IS NOT NULL
        AND last_location_at >= datetime('now', ?)`
  ).all(branchId, `-${FRESH_LOCATION_MINUTES} minutes`) as RiderRow[];
  const out = rows.map((rider) => {
    const distanceKm = (b?.lat != null && b?.lng != null && rider.last_lat != null && rider.last_lng != null)
      ? haversineKm({ lat: b.lat, lng: b.lng }, { lat: rider.last_lat, lng: rider.last_lng })
      : null;
    return { rider, distanceKm };
  });
  out.sort((a, z) => (a.distanceKm ?? 1e9) - (z.distanceKm ?? 1e9));
  return out;
}

export type DeliveryRow = {
  id: number; order_id: number; rider_id: number | null;
  assigned_at: string | null; accepted_at: string | null; picked_up_at: string | null;
  delivered_at: string | null; cod_amount: number; cod_settled: number; proof_photo_url: string | null;
};

export function getDeliveryForOrder(orderId: number): DeliveryRow | null {
  return (getDb().prepare("SELECT * FROM deliveries WHERE order_id = ?").get(orderId) as DeliveryRow | undefined) ?? null;
}

/** Dispatch: assign a rider to a ready order (branch-scoped). Creates/updates
 *  the deliveries row, moves the order to 'assigned', marks the rider busy, and
 *  records the COD amount the rider must collect (0 for prepaid). */
export function assignRider(orderId: number, riderId: number, branchId: number): void {
  const db = getDb();
  const order = getOrder(orderId);
  if (!order || order.branch_id !== branchId) throw new OrderError("order_not_found", orderId);
  const rider = getRider(riderId);
  if (!rider || rider.branch_id !== branchId || !rider.is_active) throw new OrderError("rider_not_found", riderId);
  const cod = order.pay_method === "cod" && order.pay_status !== "verified" ? order.total : 0;
  const tx = db.transaction(() => {
    const existing = getDeliveryForOrder(orderId);
    if (existing) {
      db.prepare("UPDATE deliveries SET rider_id=?, assigned_at=CURRENT_TIMESTAMP, cod_amount=?, updated_at=CURRENT_TIMESTAMP WHERE order_id=?").run(riderId, cod, orderId);
    } else {
      db.prepare("INSERT INTO deliveries (order_id, rider_id, assigned_at, cod_amount) VALUES (?,?,CURRENT_TIMESTAMP,?)").run(orderId, riderId, cod);
    }
    setOrderStatus(orderId, "assigned");
    setRiderStatus(riderId, "busy");
  });
  tx();
}

function ownedDelivery(orderId: number, riderId: number): { order: OrderRow; delivery: DeliveryRow } {
  const order = getOrder(orderId);
  const delivery = getDeliveryForOrder(orderId);
  if (!order || !delivery || delivery.rider_id !== riderId) throw new OrderError("job_not_found", orderId);
  return { order, delivery };
}

export function riderAccept(orderId: number, riderId: number): void {
  ownedDelivery(orderId, riderId);
  const r = getRider(riderId);
  if (!r || r.is_registered !== 1) throw new OrderError("rider_not_registered", riderId);
  getDb().prepare("UPDATE deliveries SET accepted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE order_id=?").run(orderId);
}

export function riderPickup(orderId: number, riderId: number): OrderStatus {
  ownedDelivery(orderId, riderId);
  getDb().prepare("UPDATE deliveries SET picked_up_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE order_id=?").run(orderId);
  return setOrderStatus(orderId, "picked_up");
}

export function riderDeliver(orderId: number, riderId: number, proofPhotoUrl?: string | null): OrderStatus {
  const { delivery } = ownedDelivery(orderId, riderId);
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("UPDATE deliveries SET delivered_at=CURRENT_TIMESTAMP, proof_photo_url=?, updated_at=CURRENT_TIMESTAMP WHERE order_id=?").run(proofPhotoUrl ?? delivery.proof_photo_url, orderId);
    setOrderStatus(orderId, "delivered");
    if (delivery.rider_id) setRiderStatus(delivery.rider_id, "available");   // free the rider
  });
  tx();
  // Sale realized on delivery → post ACCOUNTA income + INSIGNA signal (idempotent).
  runOrderHooks(orderId, "completed");
  return "delivered";
}

/** Finish a job in one tap ("จบงาน"): marks picked-up (if not already) AND
 *  delivered, frees the rider, and realizes the sale. Collapses the old
 *  pickup→deliver two-step so the rider app has just รับงาน / จบงาน. */
export function riderComplete(orderId: number, riderId: number, proofPhotoUrl?: string | null): OrderStatus {
  const { order, delivery } = ownedDelivery(orderId, riderId);
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE deliveries
          SET picked_up_at = COALESCE(picked_up_at, CURRENT_TIMESTAMP),
              delivered_at = CURRENT_TIMESTAMP,
              proof_photo_url = ?, updated_at = CURRENT_TIMESTAMP
        WHERE order_id = ?`
    ).run(proofPhotoUrl ?? delivery.proof_photo_url, orderId);
    if (order.status === "assigned") setOrderStatus(orderId, "picked_up");
    setOrderStatus(orderId, "delivered", { force: true });   // robust regardless of prior leg
    if (delivery.rider_id) setRiderStatus(delivery.rider_id, "available");   // free the rider
  });
  tx();
  runOrderHooks(orderId, "completed");
  return "delivered";
}

export type RiderJob = { order: OrderRow; delivery: DeliveryRow };

/** A rider's active jobs (not completed/cancelled), oldest first. */
export function listRiderJobs(riderId: number): RiderJob[] {
  const rows = getDb().prepare(
    `SELECT o.* FROM delivery_orders o
       JOIN deliveries d ON d.order_id = o.id
      WHERE d.rider_id = ? AND o.status NOT IN ('completed','cancelled','delivered')
      ORDER BY o.created_at`
  ).all(riderId) as OrderRow[];
  return rows.map((order) => ({ order, delivery: getDeliveryForOrder(order.id)! }));
}
