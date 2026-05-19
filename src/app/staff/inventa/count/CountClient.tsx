"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import BarcodeScanner from "@/app/components/BarcodeScanner";
import { PICK_FREQ_META, type PickFreq } from "@/lib/inventa";

export type CountItem = {
  id: number;
  item_code: string | null;
  barcode: string | null;
  name: string;
  generic_name: string | null;
  unit: string | null;
  grid_row: string | null;
  grid_col: number | null;
  pick_freq: PickFreq | null;
  current_qty: number;
  safety_stock: number;
};

export default function CountClient({
  items, session, initialCounted
}: {
  items: CountItem[];
  session: { id: number; count_date: string } | null;
  initialCounted: Record<number, number>;
}) {
  const router = useRouter();
  const { t } = useLang();
  const [, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());

  const [counted, setCounted] = useState<Record<number, number>>(initialCounted);
  const [sel, setSel] = useState<CountItem | null>(null);
  const [qty, setQty] = useState("");
  const [scanCam, setScanCam] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const total = items.length;
  const done = Object.keys(counted).length;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items;
    return items.filter((i) => [
      i.name, i.generic_name, i.item_code, i.barcode
    ].some((v) => (v ?? "").toLowerCase().includes(term)));
  }, [items, q]);

  function pick(item: CountItem) {
    setSel(item);
    setMsg(null);
    setQty(counted[item.id] !== undefined ? String(counted[item.id]) : "");
  }

  function resolveBarcode(code: string) {
    const c = code.trim();
    if (!c) return;
    const hit = items.find(
      (i) => (i.barcode ?? "") === c || (i.item_code ?? "") === c
    );
    if (hit) pick(hit);
    else setMsg(t("inv.cnt.notFound", { code: c }));
    if (scanRef.current) scanRef.current.value = "";
  }

  async function startSession() {
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/inventa/counts"), { method: "POST" });
      if (res.ok) refresh();
    } finally { setBusy(false); }
  }

  async function saveLine() {
    if (!sel || !session) return;
    const n = Number(qty);
    if (!Number.isInteger(n) || n < 0) { setMsg(t("inv.cnt.intError")); return; }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/inventa/counts/${session.id}/line`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: sel.id, counted_qty: n })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) { setMsg(j?.error ?? t("inv.cnt.saveFail")); return; }
      setCounted((p) => ({ ...p, [sel.id]: n }));
      setSel(null);
      setQty("");
    } finally { setBusy(false); }
  }

  async function submit() {
    if (!session) return;
    if (!confirm(t("inv.cnt.submitConfirm", { done, total }))) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/counts/${session.id}/submit`), {
        method: "POST"
      });
      if (res.ok) refresh();
    } finally { setBusy(false); }
  }

  if (!session) {
    return (
      <div className="card text-center space-y-3 py-8">
        <p className="text-slate-600">{t("inv.cnt.noSession")}</p>
        <button type="button" onClick={startSession} disabled={busy}
          className="px-6 py-2.5 rounded-lg bg-brand text-white font-bold disabled:opacity-50">
          {busy ? t("inv.cnt.opening") : t("inv.cnt.start")}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="card space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-sm text-slate-600">
            {t("inv.cnt.roundDate")} <span className="font-bold text-slate-800">{session.count_date}</span>
          </div>
          <div className="text-sm">
            {t("inv.cnt.counted")} <span className="font-bold text-brand">{done}</span> / {total}
          </div>
        </div>
        <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full bg-brand transition-all"
            style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>

        <div className="flex flex-wrap gap-2">
          <input ref={scanRef} className="input flex-1 min-w-[180px]"
            placeholder={t("inv.cnt.scanPh")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                resolveBarcode((e.target as HTMLInputElement).value);
              }
            }} />
          <button type="button" onClick={() => setScanCam(true)}
            className="text-sm px-4 py-2 rounded-lg border border-brand text-brand font-bold hover:bg-rose-50">
            {t("inv.btn.scanQr")}
          </button>
          <button type="button" onClick={submit} disabled={busy}
            className="text-sm px-4 py-2 rounded-lg bg-brand text-white font-bold disabled:opacity-50">
            {t("inv.cnt.submit")}
          </button>
        </div>
        {msg && <div className="text-sm text-rose-600">{msg}</div>}
      </div>

      {sel && (
        <div className="card space-y-3 border-2 border-brand">
          <div>
            <div className="flex items-center gap-2">
              {sel.pick_freq && (
                <span title={PICK_FREQ_META[sel.pick_freq].label}
                  className={`inline-block w-3.5 h-3.5 rounded-full ${PICK_FREQ_META[sel.pick_freq].dot}`} />
              )}
              <span className="font-bold text-slate-800">{sel.name}</span>
            </div>
            {sel.generic_name && (
              <div className="text-xs text-slate-400 mt-0.5">{sel.generic_name}</div>
            )}
          </div>
          <div>
            <label className="label">
              {t("inv.cnt.qtyLabel", { unit: sel.unit ?? t("inv.ord.unit") })}
            </label>
            <input className="input text-lg font-bold" type="number" min="0"
              autoFocus value={qty} placeholder={t("inv.cnt.qtyPh")}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveLine(); }} />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => { setSel(null); setQty(""); }}
              disabled={busy}
              className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm">
              {t("inv.btn.cancel")}
            </button>
            <button type="button" onClick={saveLine} disabled={busy}
              className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
              {busy ? t("inv.btn.saving") : t("inv.cnt.saveQty")}
            </button>
          </div>
        </div>
      )}

      <div className="card space-y-2">
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={t("inv.cnt.searchPh")} />
        <div className="divide-y divide-slate-100 max-h-[50vh] overflow-y-auto">
          {filtered.map((i) => {
            const c = counted[i.id];
            const isDone = c !== undefined;
            const fm = i.pick_freq ? PICK_FREQ_META[i.pick_freq] : null;
            return (
              <button key={i.id} type="button" onClick={() => pick(i)}
                className="w-full text-left py-2 flex items-center justify-between gap-2 hover:bg-slate-50">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {fm && (
                      <span title={fm.label}
                        className={`inline-block w-3 h-3 rounded-full ${fm.dot}`} />
                    )}
                    <span className="font-medium text-slate-800 truncate">{i.name}</span>
                  </div>
                </div>
                <div className="flex-shrink-0 text-sm">
                  {isDone
                    ? <span className="text-emerald-600 font-bold">{t("inv.cnt.countedTag", { n: c })}</span>
                    : <span className="text-slate-400">{t("inv.cnt.notCounted")}</span>}
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="py-6 text-center text-slate-400 text-sm">{t("inv.cnt.noItems")}</div>
          )}
        </div>
      </div>

      {scanCam && (
        <BarcodeScanner
          title={t("inv.cnt.scanTitle")}
          onResult={(code) => resolveBarcode(code)}
          onClose={() => setScanCam(false)}
        />
      )}
    </>
  );
}
