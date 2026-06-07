"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import PinPromptModal from "@/app/components/PinPromptModal";

type Status = "draft" | "sent" | "approved" | "paid" | "shipping" | "received" | "returned" | "cancelled";

// Print + lifecycle actions for one purchase order. Hidden in print
// (.no-print on the parent row). Approve is management-only; cancel /
// receive are open to the creator or an admin. "Send back to edit"
// (admin only) flips an approved order back to 'sent' so its lines can
// be corrected — PIN-gated since it undoes an approval (owner 2026-06-07).
export default function PrintActions({
  orderId, status, canApprove, canManage, supplierPdfUrl
}: {
  orderId: number;
  status: Status;
  canApprove: boolean;
  canManage: boolean;
  supplierPdfUrl?: string | null;
}) {
  const router = useRouter();
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showSendBack, setShowSendBack] = useState(false);
  const [copied, setCopied] = useState(false);

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
    action: "approve" | "cancel" | "receive" | "pay" | "credit" | "ship" | "return",
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
          onClick={() => act("receive", "ยืนยันรับของเข้าคลังครบแล้ว?")}
          className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold hover:opacity-90 disabled:opacity-50">
          รับเข้าคลัง
        </button>
      )}
      {canManage && (status === "paid" || status === "shipping" || status === "received") && (
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
          <button type="button" onClick={copySupplierLink}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 font-bold hover:bg-slate-50">
            {copied ? "คัดลอกลิงก์แล้ว ✓" : "คัดลอกลิงก์ส่งผู้จำหน่าย"}
          </button>
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
    </div>
  );
}
