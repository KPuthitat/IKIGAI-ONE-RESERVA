"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import PinPromptModal from "@/app/components/PinPromptModal";

type Status = "draft" | "sent" | "approved" | "paid" | "shipping" | "received" | "returned" | "cancelled";

type ReceiveLine = {
  item_id: number; name: string; code: string | null; unit: string | null;
  order_qty: number; current_cost: number | null; avg_cost: number | null;
};

// Print + lifecycle actions for one purchase order. Hidden in print
// (.no-print on the parent row). Approve is management-only; cancel /
// receive are open to the creator or an admin. "Send back to edit"
// (admin only) flips an approved order back to 'sent' so its lines can
// be corrected — PIN-gated since it undoes an approval (owner 2026-06-07).
export default function PrintActions({
  orderId, status, canApprove, canManage, supplierPdfUrl, receiveLines = [],
  stockAppliedAt = null
}: {
  orderId: number;
  status: Status;
  canApprove: boolean;
  canManage: boolean;
  supplierPdfUrl?: string | null;
  receiveLines?: ReceiveLine[];
  /** When set, this PO's quantities have already been added to on-hand
   *  stock. null on POs received before the auto-bump shipped → offer a
   *  one-time "ปรับสต๊อกตามใบนี้" top-up. */
  stockAppliedAt?: string | null;
}) {
  const router = useRouter();
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showSendBack, setShowSendBack] = useState(false);
  const [copied, setCopied] = useState(false);
  // Receive modal — enter the current cost per item (owner 2026-06-09).
  const [showReceive, setShowReceive] = useState(false);
  const [costInputs, setCostInputs] = useState<Record<number, string>>({});

  function openReceive() {
    const init: Record<number, string> = {};
    for (const l of receiveLines) init[l.item_id] = l.current_cost != null ? String(l.current_cost) : "";
    setCostInputs(init);
    setErr(null);
    setShowReceive(true);
  }
  async function submitReceive() {
    setBusy(true); setErr(null);
    try {
      const costs = receiveLines.map((l) => ({
        item_id: l.item_id,
        unit_cost: costInputs[l.item_id]?.trim() ? Number(costInputs[l.item_id]) : null
      }));
      const res = await fetch(apiUrl(`/api/inventa/orders/${orderId}/status`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "receive", costs })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? t("inv.po.actFail")); return; }
      setShowReceive(false);
      router.refresh();
    } catch {
      setErr(t("inv.po.actFail"));
    } finally {
      setBusy(false);
    }
  }

  async function copySupplierLink() {
    if (!supplierPdfUrl) return;
    try {
      await navigator.clipboard.writeText(supplierPdfUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard blocked (rare) — open the link so they can copy manually.
      window.open(supplierPdfUrl, "_blank", "noopener");
    }
  }

  async function act(
    action: "approve" | "cancel" | "receive" | "pay" | "credit" | "ship" | "return" | "apply_stock",
    confirmMsg: string
  ) {
    if (!window.confirm(confirmMsg)) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/inventa/orders/${orderId}/status`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? t("inv.po.actFail")); return; }
      router.refresh();
    } catch {
      setErr(t("inv.po.actFail"));
    } finally {
      setBusy(false);
    }
  }

  async function sendBack(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const res = await fetch(apiUrl(`/api/inventa/orders/${orderId}/status`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send_back", pin })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) return { ok: false, message: j.error ?? t("inv.po.actFail") };
    setShowSendBack(false);
    router.refresh();
    return { ok: true };
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {err && <span className="text-xs text-rose-600">{err}</span>}

      {canApprove && status === "sent" && (
        <button type="button" disabled={busy}
          onClick={() => act("approve", t("inv.po.cfApprove"))}
          className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold hover:opacity-90 disabled:opacity-50">
          {t("inv.po.approve")}
        </button>
      )}
      {canApprove && status === "approved" && (
        <button type="button" disabled={busy}
          onClick={() => setShowSendBack(true)}
          className="text-xs px-3 py-1.5 rounded-lg border border-amber-400 text-amber-700 font-bold hover:bg-amber-50 disabled:opacity-50">
          {t("inv.po.sendBack")}
        </button>
      )}
      {/* Procurement flow (owner 2026-06-08): approved → ชำระเงิน|เครดิต →
          จัดส่ง → รับเข้าคลัง, plus ส่งคืนผู้จำหน่าย. */}
      {canManage && status === "approved" && (
        <>
          <button type="button" disabled={busy}
            onClick={() => act("pay", "บันทึกว่าชำระเงินแล้ว?")}
            className="text-xs px-3 py-1.5 rounded-lg bg-teal-600 text-white font-bold hover:opacity-90 disabled:opacity-50">
            บันทึกชำระเงิน
          </button>
          <button type="button" disabled={busy}
            onClick={() => act("credit", "บันทึกเป็นเครดิต/วางบิล แล้วข้ามไปขั้นจัดส่ง?")}
            className="text-xs px-3 py-1.5 rounded-lg border border-teal-500 text-teal-700 font-bold hover:bg-teal-50 disabled:opacity-50">
            เครดิต/วางบิล → จัดส่ง
          </button>
        </>
      )}
      {canManage && status === "paid" && (
        <button type="button" disabled={busy}
          onClick={() => act("ship", "บันทึกว่ากำลังจัดส่ง?")}
          className="text-xs px-3 py-1.5 rounded-lg bg-sky-600 text-white font-bold hover:opacity-90 disabled:opacity-50">
          เริ่มจัดส่ง
        </button>
      )}
      {canManage && status === "shipping" && (
        <button type="button" disabled={busy}
          onClick={openReceive}
          className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold hover:opacity-90 disabled:opacity-50">
          รับเข้าคลัง
        </button>
      )}
      {/* ส่งคืนผู้จำหน่าย only BEFORE goods are received — once รับเข้าคลังแล้ว
          the stock is in, so this is hidden (owner 2026-06-09). */}
      {canManage && (status === "paid" || status === "shipping") && (
        <button type="button" disabled={busy}
          onClick={() => act("return", "บันทึกว่าส่งคืนผู้จำหน่าย?")}
          className="text-xs px-3 py-1.5 rounded-lg border border-orange-400 text-orange-700 hover:bg-orange-50 disabled:opacity-50">
          ส่งคืนผู้จำหน่าย
        </button>
      )}
      {canManage && (status === "sent" || status === "approved") && (
        <button type="button" disabled={busy}
          onClick={() => act("cancel", t("inv.po.cfCancel"))}
          className="text-xs px-3 py-1.5 rounded-lg border border-rose-300 text-rose-600 hover:bg-rose-50 disabled:opacity-50">
          {t("inv.po.cancel")}
        </button>
      )}
      {/* One-time stock top-up for a PO received BEFORE the auto-bump
          shipped (owner 2026-06-11). Hidden once applied — idempotent on
          the server too, so it can never double-count. */}
      {canManage && status === "received" && !stockAppliedAt && (
        <button type="button" disabled={busy}
          onClick={() => act("apply_stock",
            "บวกจำนวนสินค้าในใบนี้เข้ายอดคงเหลือ?\n\nใช้สำหรับใบที่รับเข้าไว้ก่อนระบบบวกอัตโนมัติ — ทำได้ครั้งเดียวต่อใบ (กดซ้ำไม่บวกซ้ำ)")}
          className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold hover:opacity-90 disabled:opacity-50">
          ปรับสต๊อกตามใบนี้ (บวกยอดคงเหลือ)
        </button>
      )}
      {/* Real A4 PDF (owner 2026-06-06) — opens in a new tab so the
          owner can view, download, or print from the PDF viewer. On
          mobile this opens the native PDF viewer (much better than the
          old browser-print preview that overflowed the page). */}
      <a
        href={apiUrl(`/api/inventa/orders/${orderId}/pdf`)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs px-3 py-1.5 rounded-lg bg-brand text-white font-bold hover:opacity-90">
        เปิด / ดาวน์โหลด PDF
      </a>
      {/* Supplier link (owner 2026-06-08) — a public PDF (cost hidden, no
          login) to forward to the vendor. Copy to clipboard for LINE/email. */}
      {supplierPdfUrl && (
        <>
          {/* Once received, don't offer "copy link" again — stamp it instead
              so no one re-sends / re-orders (owner 2026-06-09). Viewing is
              still fine. */}
          {status === "received" ? (
            <span className="text-xs px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-300 text-emerald-700 font-bold">
              ✓ รับเข้าคลังแล้ว — ไม่ต้องส่งซ้ำ
            </span>
          ) : (
            <button type="button" onClick={copySupplierLink}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 font-bold hover:bg-slate-50">
              {copied ? "คัดลอกลิงก์แล้ว ✓" : "คัดลอกลิงก์ส่งผู้จำหน่าย"}
            </button>
          )}
          <a href={supplierPdfUrl} target="_blank" rel="noopener noreferrer"
            className="text-xs text-brand hover:underline self-center">
            เปิดดู
          </a>
        </>
      )}

      {showSendBack && (
        <PinPromptModal
          title={t("inv.po.cfSendBackTitle")}
          description={t("inv.po.cfSendBackHint")}
          submitLabel={t("inv.po.sendBackConfirm")}
          onSubmit={sendBack}
          onClose={() => setShowSendBack(false)}
        />
      )}

      {/* Receive modal — confirm receipt + set the current cost per item.
          The faint number under each input is the moving-average cost, to
          guide a cost adjustment (owner 2026-06-09). */}
      {showReceive && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setShowReceive(false)}>
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <div>
              <h3 className="font-bold text-slate-800 text-base">รับเข้าคลัง — ตรวจ/ปรับราคาทุน</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                กรอกราคาทุนปัจจุบันต่อหน่วย (ปรับได้ถ้าราคาเปลี่ยน) — ระบบจะอัปเดตราคาทุนของสินค้าและบันทึกประวัติให้
              </p>
            </div>
            {/* Stock-accuracy notice (owner 2026-06-10): receiving bumps
                on-hand by the ordered qty, but the clinic's POS deducts
                stock on its own, so the figure drifts until the next count. */}
            <div className="text-[11px] leading-relaxed rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2">
              ระบบจะบวกจำนวนที่รับเข้านี้เข้ากับยอดคงเหลือของสินค้า — ระหว่างรอบนับสต๊อคอาจมีการใช้สินค้าออก จำนวนคงเหลืออาจไม่ตรงกับของจริง จนกว่าจะนับสต๊อคครั้งต่อไป
            </div>
            {err && <div className="text-xs text-rose-600">{err}</div>}
            <div className="space-y-2">
              {receiveLines.map((l) => (
                <div key={l.item_id} className="flex items-center gap-2 border-b border-slate-100 pb-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-800 truncate">{l.name}</div>
                    <div className="text-[11px] text-slate-400">
                      {l.code ?? "—"} · สั่ง {l.order_qty}{l.unit ? ` ${l.unit}` : ""}
                    </div>
                  </div>
                  <div className="w-28 flex-shrink-0">
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-slate-400">฿</span>
                      <input type="number" min="0" step="0.01" inputMode="decimal"
                        className="input text-sm text-right py-1"
                        value={costInputs[l.item_id] ?? ""}
                        onChange={(e) => setCostInputs((p) => ({ ...p, [l.item_id]: e.target.value }))}
                        placeholder={l.avg_cost != null ? String(l.avg_cost) : "0.00"} />
                    </div>
                    <div className="text-[10px] text-slate-300 text-right mt-0.5">
                      {l.avg_cost != null ? `เฉลี่ย ฿${l.avg_cost.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
                    </div>
                  </div>
                </div>
              ))}
              {receiveLines.length === 0 && (
                <p className="text-xs text-slate-400 text-center py-2">ไม่มีรายการในใบสั่งซื้อ</p>
              )}
            </div>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setShowReceive(false)} disabled={busy}
                className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium disabled:opacity-50">
                {t("common.cancel")}
              </button>
              <button type="button" onClick={submitReceive} disabled={busy}
                className="flex-1 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-bold disabled:opacity-50">
                {busy ? "กำลังบันทึก…" : "ยืนยันรับเข้าคลัง"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
