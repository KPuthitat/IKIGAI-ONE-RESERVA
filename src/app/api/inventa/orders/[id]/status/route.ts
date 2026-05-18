import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/inventa/orders/:id/status — move an order along its
// lifecycle.  sent → approved → received, or → cancelled.
//
//   approve  : management only (admin / super_admin). sent → approved
//   receive  : admin / super_admin OR the creator. approved → received
//   cancel   : creator OR admin / super_admin. sent|approved → cancelled
//
// Branch scope: the order must belong to the caller's active branch
// (super_admin may act on any branch).

const Body = z.object({
  action: z.enum(["approve", "cancel", "receive"])
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const db = getDb();
  const order = db.prepare(
    "SELECT id, branch_id, status, created_by FROM inventa_orders WHERE id = ?"
  ).get(id) as
    | { id: number; branch_id: number | null; status: string; created_by: number | null }
    | undefined;
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const isSuper = user.role === "super_admin";
  const isAdmin = user.role === "admin" || isSuper;
  const isCreator = order.created_by === user.id;

  // Branch guard (super_admin is global).
  if (!isSuper && order.branch_id !== (user.activeBranchId ?? null)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const action = parsed.data.action;
  const nowIso = new Date().toISOString();

  if (action === "approve") {
    if (!isAdmin) {
      return NextResponse.json({ error: "approver_must_be_admin" }, { status: 403 });
    }
    if (order.status !== "sent") {
      return NextResponse.json({ error: "bad_state", status: order.status }, { status: 409 });
    }
    db.prepare(
      "UPDATE inventa_orders SET status='approved', approved_by=?, approved_at=? WHERE id=?"
    ).run(user.id, nowIso, id);
    return NextResponse.json({ ok: true, status: "approved" });
  }

  if (action === "receive") {
    if (!isAdmin && !isCreator) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (order.status !== "approved") {
      return NextResponse.json({ error: "bad_state", status: order.status }, { status: 409 });
    }
    db.prepare("UPDATE inventa_orders SET status='received' WHERE id=?").run(id);
    return NextResponse.json({ ok: true, status: "received" });
  }

  // cancel
  if (!isAdmin && !isCreator) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (order.status !== "sent" && order.status !== "approved") {
    return NextResponse.json({ error: "bad_state", status: order.status }, { status: 409 });
  }
  db.prepare("UPDATE inventa_orders SET status='cancelled' WHERE id=?").run(id);
  return NextResponse.json({ ok: true, status: "cancelled" });
}
