"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLang } from "@/lib/LangProvider";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { WASTE_REASONS, wasteReasonLabel, type WasteReason, type WasteRow } from "@/lib/inventa-waste";

export type WasteItem = { id: number; name: string; unit: string | null; unit_cost: number };

function todayBkk(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

// Downscale a captured photo to a ~1280px long-edge JPEG data-URL so uploads
// stay small (the server caps at 2MB). Rejects non-images by resolving null.
function downscaleToDataUrl(file: File, maxEdge = 1280, quality = 0.7): Promise<string | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/")) return resolve(null);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

export default function WasteClient({
  items, rows, showReportLink
}: {
  items: WasteItem[];
  rows: WasteRow[];
  showReportLink: boolean;
}) {
  const { t, lang } = useLang();
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [itemId, setItemId] = useState<number | "">("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState<WasteReason>("expired");
  const [wastedOn, setWastedOn] = useState(todayBkk());
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";   // allow re-picking the same file
    if (!file) return;
    const data = await downscaleToDataUrl(file);
    if (!data) { setMsg({ kind: "err", text: t("inv.waste.photoError") }); return; }
    setPhoto(data);
  }

  const selectedItem = items.find((i) => i.id === itemId) || null;
  const qtyNum = Number(qty);
  const canSubmit = itemId !== "" && qtyNum > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/inventa/waste"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: itemId, qty: qtyNum, reason, note: note.trim() || undefined, wasted_on: wastedOn, photo: photo ?? undefined })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) throw new Error(j?.error ?? "error");
      setMsg({ kind: "ok", text: t("inv.waste.saved") });
      setQty(""); setNote(""); setPhoto(null);
      startTransition(() => router.refresh());
    } catch (e) {
      // A rejected photo (too large / bad format) shouldn't look like a generic save failure.
      const code = e instanceof Error ? e.message : "";
      setMsg({ kind: "err", text: t(code.startsWith("photo_") ? "inv.waste.photoError" : "inv.waste.saveError") });
    } finally {
      setBusy(false);
    }
  }

  const totalValue = rows.reduce((s, r) => s + r.value, 0);

  return (
    <div className="space-y-4">
      {/* Entry form */}
      <div className="card space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="label">{t("inv.waste.field.item")}</span>
            <select className="input" value={itemId}
              onChange={(e) => setItemId(e.target.value === "" ? "" : Number(e.target.value))}>
              <option value="">{t("inv.waste.field.itemPlaceholder")}</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>{i.name}{i.unit ? ` (${i.unit})` : ""}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">{t("inv.waste.field.qty")}{selectedItem?.unit ? ` · ${selectedItem.unit}` : ""}</span>
            <input className="input" type="number" inputMode="decimal" min="0" step="any"
              value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
          </label>
          <label className="block">
            <span className="label">{t("inv.waste.field.reason")}</span>
            <select className="input" value={reason} onChange={(e) => setReason(e.target.value as WasteReason)}>
              {WASTE_REASONS.map((r) => (
                <option key={r.code} value={r.code}>{wasteReasonLabel(r.code, lang)}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">{t("inv.waste.field.date")}</span>
            <input className="input" type="date" max={todayBkk()} value={wastedOn} onChange={(e) => setWastedOn(e.target.value)} />
          </label>
        </div>
        <label className="block">
          <span className="label">{t("inv.waste.field.note")}</span>
          <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
            placeholder={t("inv.waste.field.notePlaceholder")} />
        </label>
        <div className="block">
          <span className="label">{t("inv.waste.field.photo")}</span>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="btn-ghost text-sm cursor-pointer">
              {photo ? t("inv.waste.photoRetake") : t("inv.waste.photoAdd")}
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPickPhoto} />
            </label>
            {photo && (
              <>
                <button type="button" onClick={() => setZoom(photo)} className="shrink-0">
                  <img src={photo} alt="" className="h-14 w-14 rounded object-cover border border-slate-200" />
                </button>
                <button type="button" onClick={() => setPhoto(null)}
                  className="text-xs text-rose-600 hover:underline">{t("inv.waste.photoRemove")}</button>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" onClick={submit} disabled={!canSubmit}
            className="btn-primary text-sm disabled:opacity-50">
            {busy ? "…" : t("inv.waste.save")}
          </button>
          {msg && <span className={`text-sm ${msg.kind === "ok" ? "text-emerald-600" : "text-rose-600"}`}>{msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}</span>}
          {showReportLink && (
            <Link href="/staff/inventa/waste/report" className="ml-auto text-sm text-brand hover:underline">
              {t("inv.waste.reportLink")} →
            </Link>
          )}
        </div>
      </div>

      {/* Recent entries */}
      <div className="card overflow-x-auto">
        <div className="flex items-baseline justify-between gap-2 mb-2 flex-wrap">
          <h2 className="font-bold text-slate-800">{t("inv.waste.recent")}</h2>
          <span className="text-xs text-slate-500">{t("inv.waste.totalValue")} <span className="font-semibold text-rose-600">{fmtMoney(totalValue)}</span></span>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-400 py-4 text-center">{t("inv.waste.empty")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">{t("inv.waste.col.date")}</th>
                <th className="py-2 pr-3">{t("inv.waste.col.item")}</th>
                <th className="py-2 pr-3 text-right">{t("inv.waste.col.qty")}</th>
                <th className="py-2 pr-3">{t("inv.waste.col.reason")}</th>
                <th className="py-2 pr-3 text-right">{t("inv.waste.col.value")}</th>
                <th className="py-2 pr-3">{t("inv.waste.col.photo")}</th>
                <th className="py-2 pr-3">{t("inv.waste.col.by")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap text-slate-600">{w.wasted_on}</td>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800">{w.item_name}</div>
                    {w.note && <div className="text-[11px] text-slate-400">{w.note}</div>}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">{w.qty}{w.unit ? ` ${w.unit}` : ""}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{wasteReasonLabel(w.reason, lang)}</span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-rose-600">{fmtMoney(w.value)}</td>
                  <td className="py-2 pr-3">
                    {w.photoUrl ? (
                      <button type="button" onClick={() => setZoom(w.photoUrl)} className="block">
                        <img src={w.photoUrl} alt="" loading="lazy" className="h-10 w-10 rounded object-cover border border-slate-200" />
                      </button>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{w.logged_by_name ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {zoom && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setZoom(null)}>
          <img src={zoom} alt="" className="max-h-full max-w-full rounded shadow-lg" />
        </div>
      )}
    </div>
  );
}
