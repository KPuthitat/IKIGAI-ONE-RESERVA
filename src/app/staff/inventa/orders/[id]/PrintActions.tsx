"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type Status = "draft" | "sent" | "approved" | "received" | "cancelled";

// Print + lifecycle actions for one purchase order. Hidden in print
// (.no-print on the parent row). Approve is management-only; cancel /
// receive are open to the creator or an admin.
export default function PrintActions({
  orderId, status, canApprove, canManage
}: {
  orderId: number;
  status: Status;
  canApprove: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function act(action: "approve" | "cancel" | "receive", confirmMsg: string) {
    if (!window.confirm(confirmMsg)) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/inventa/orders/${orderId}/status`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? "ทำรายการไม่สำเร็จ"); return; }
      router.refresh();
    } catch {
      setErr("ทำรายการไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {err && <span className="text-xs text-rose-600">{err}</span>}

      {canApprove && status === "sent" && (
        <button type="button" disabled={busy}
          onClick={() => act("approve", "อนุมัติใบสั่งซื้อนี้?")}
          className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold hover:opacity-90 disabled:opacity-50">
          อนุมัติ
        </button>
      )}
      {canManage && status === "approved" && (
        <button type="button" disabled={busy}
          onClick={() => act("receive", "ยืนยันว่ารับของครบแล้ว?")}
          className="text-xs px-3 py-1.5 rounded-lg border border-sky-400 text-sky-700 font-bold hover:bg-sky-50 disabled:opacity-50">
          รับของแล้ว
        </button>
      )}
      {canManage && (status === "sent" || status === "approved") && (
        <button type="button" disabled={busy}
          onClick={() => act("cancel", "ยกเลิกใบสั่งซื้อนี้?")}
          className="text-xs px-3 py-1.5 rounded-lg border border-rose-300 text-rose-600 hover:bg-rose-50 disabled:opacity-50">
          ยกเลิก
        </button>
      )}
      <button type="button"
        onClick={() => window.print()}
        className="text-xs px-3 py-1.5 rounded-lg bg-brand text-white font-bold hover:opacity-90">
        พิมพ์ / บันทึก PDF
      </button>
    </div>
  );
}
