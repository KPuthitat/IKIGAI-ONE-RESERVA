"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import BarcodeScanner from "@/app/components/BarcodeScanner";
import PinPromptModal from "@/app/components/PinPromptModal";
import { useConfirm } from "@/app/components/useConfirm";
import {
  PICK_FREQ_META, hasPack, packToBase, packBreakdown, packRelationCaption,
  isFractionalItem, formatFracQty,
  type PickFreq
} from "@/lib/inventa";

export type CountSession = {
  id: number;
  count_date: string;
  opened_at?: string | null;
  reopened?: boolean;
};
export type LastSubmitted = {
  id: number;
  count_date: string;
  submitted_at: string | null;
};

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
  category: string | null;
  item_type?: string | null;
  storage_location?: string | null;
  supplier_name?: string | null;
  pack_unit?: string | null;
  pack_size?: number | null;
  count_mode?: "discrete" | "fractional" | null;
  qty_frac?: number | null;
};

export default function CountClient({
  items, categories = [], session, lastSubmitted = null, initialCounted
}: {
  items: CountItem[];
  categories?: string[];
  session: CountSession | null;
  lastSubmitted?: LastSubmitted | null;
  initialCounted: Record<number, number>;
}) {
  const router = useRouter();
  const { t } = useLang();
  const { confirm, ConfirmDialog } = useConfirm();
  const [, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());

  const [counted, setCounted] = useState<Record<number, number>>(initialCounted);
  const [sel, setSel] = useState<CountItem | null>(null);
  const [qty, setQty] = useState("");
  // N5 pack-entry aid: typing packs + loose computes the base qty.
  const [packIn, setPackIn] = useState("");
  const [looseIn, setLooseIn] = useState("");
  // Fractional-count aid (owner 2026-06-16): full bottles + a 0-100% slider
  // for the open bottle → total bottles (decimal) stored in `qty`.
  const [fullBottles, setFullBottles] = useState("");
  const [openPct, setOpenPct] = useState(0);
  const [scanCam, setScanCam] = useState(false);
  const [q, setQ] = useState("");
  // Filters — mirror the catalogue page (pick frequency + category) plus
  // an "uncounted only" toggle that's handy mid-count.
  const [freqFilter, setFreqFilter] = useState<PickFreq | "">("");
  const [catFilter, setCatFilter] = useState("");
  // Supplier + location filters (owner 2026-06-06) — match the catalogue
  // page. Option lists derived from the items present in this round.
  const [supFilter, setSupFilter] = useState("");
  const [locFilter, setLocFilter] = useState("");
  const [uncountedOnly, setUncountedOnly] = useState(false);

  const supplierOptions = useMemo(
    () => [...new Set(items.map((i) => i.supplier_name).filter((s): s is string => !!s))].sort(),
    [items]
  );
  const locationOptions = useMemo(
    () => [...new Set(items.map((i) => i.storage_location).filter((s): s is string => !!s))].sort(),
    [items]
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [reopenPin, setReopenPin] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  // Reopen the last submitted round for correction (PIN-gated + logged).
  async function reopenLast(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!lastSubmitted) return { ok: false, message: "ไม่พบรอบที่ปิดไป" };
    const res = await fetch(apiUrl(`/api/inventa/counts/${lastSubmitted.id}/reopen`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin })
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j?.ok) {
      setReopenPin(false);
      refresh();
      return { ok: true };
    }
    const map: Record<string, string> = {
      another_open: "มีรอบที่เปิดอยู่แล้ว",
      not_submitted: "รอบนี้ไม่ได้อยู่ในสถานะปิด",
      not_found: "ไม่พบรอบนี้"
    };
    return { ok: false, message: map[j?.error] ?? j?.error ?? "ไม่สำเร็จ" };
  }

  const total = items.length;
  const done = Object.keys(counted).length;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return items.filter((i) => {
      if (freqFilter && i.pick_freq !== freqFilter) return false;
      if (catFilter && (i.category ?? "") !== catFilter) return false;
      if (supFilter && (i.supplier_name ?? "") !== supFilter) return false;
      if (locFilter && (i.storage_location ?? "") !== locFilter) return false;
      if (uncountedOnly && counted[i.id] !== undefined) return false;
      if (!term) return true;
      return [i.name, i.generic_name, i.item_code, i.barcode, i.category]
        .some((v) => (v ?? "").toLowerCase().includes(term));
    });
  }, [items, q, freqFilter, catFilter, supFilter, locFilter, uncountedOnly, counted]);

  function pick(item: CountItem) {
    setSel(item);
    setMsg(null);
    const existing = counted[item.id];
    if (isFractionalItem(item)) {
      // Seed full-bottles + open% from this round's value, else the item's
      // live on-hand (so the slider starts where the stock actually is).
      const v = existing !== undefined ? existing : (item.qty_frac ?? 0);
      let full = Math.floor(v + 1e-9);
      let pct = Math.round((v - full) * 100);
      if (pct >= 100) { full += 1; pct = 0; }
      setFullBottles(v > 0 ? String(full) : "");
      setOpenPct(pct);
      setQty(String(v));
      setPackIn(""); setLooseIn("");
      return;
    }
    setFullBottles(""); setOpenPct(0);
    setQty(existing !== undefined ? String(existing) : "");
    // Seed the pack/loose aid from the existing value (or blank).
    if (hasPack(item) && existing !== undefined) {
      const { packs, loose } = packBreakdown(existing, item.pack_size);
      setPackIn(String(packs));
      setLooseIn(String(loose));
    } else {
      setPackIn("");
      setLooseIn("");
    }
  }

  // Recompute the base-unit qty from the pack + loose aid inputs.
  function syncPackToQty(nextPack: string, nextLoose: string) {
    if (!sel) return;
    setPackIn(nextPack);
    setLooseIn(nextLoose);
    const base = packToBase(Number(nextPack) || 0, Number(nextLoose) || 0, sel.pack_size);
    setQty(String(base));
  }

  // Fractional aid: full bottles + open-bottle % → total bottles (decimal).
  function syncFracToQty(nextFull: string, nextPct: number) {
    setFullBottles(nextFull);
    setOpenPct(nextPct);
    const total = (Number(nextFull) || 0) + nextPct / 100;
    setQty(String(Math.round(total * 100) / 100));
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
    const frac = isFractionalItem(sel);
    // Fractional (bottle) items accept a decimal; discrete must be whole.
    if (!isFinite(n) || n < 0 || (!frac && !Number.isInteger(n))) {
      setMsg(frac ? "ค่าไม่ถูกต้อง" : t("inv.cnt.intError")); return;
    }
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

  // Flag the selected item's expiry/condition while counting (owner
  // 2026-06-06). Sends a LINE alert to the INVENTA group; keeps the
  // item open so staff can still enter its counted qty.
  async function reportStatus(status: "expiring_60" | "expiring_30" | "expired" | "deteriorated") {
    if (!sel) return;
    const labels: Record<string, string> = {
      expiring_60: "ใกล้หมดอายุ 60 วัน", expiring_30: "ใกล้หมดอายุ 30 วัน",
      expired: "หมดอายุ", deteriorated: "เสื่อมสภาพ"
    };
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/inventa/expiry-report"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: sel.id, status })
      });
      const j = await res.json().catch(() => ({}));
      setMsg(res.ok && j?.ok
        ? `แจ้งกลุ่มแล้ว: ${sel.name} — ${labels[status]}`
        : "แจ้งเตือนไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally { setBusy(false); }
  }

  // silent=true closes the round WITHOUT pinging the LINE group — for
  // minor corrections (owner 2026-06-06). silent=false is the normal
  // "submit + announce + go build the PO" flow.
  async function submit(silent = false) {
    if (!session) return;
    if (!silent) {
      const ok = await confirm({ title: "ยืนยัน", body: t("inv.cnt.submitConfirm", { done, total }), confirmLabel: "ตกลง", cancelLabel: "ยกเลิก", variant: "default" });
      if (ok === null) return;
    }
    if (silent) {
      const ok = await confirm({ title: "บันทึกการนับโดยไม่แจ้งกลุ่มไลน์?", confirmLabel: "ตกลง", cancelLabel: "ยกเลิก", variant: "default" });
      if (ok === null) return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(
        apiUrl(`/api/inventa/counts/${session.id}/submit${silent ? "?silent=1" : ""}`),
        { method: "POST" }
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setMsg(j?.error ?? t("inv.cnt.saveFail"));
        return;
      }
      if (silent) {
        // Quiet save — stay on the page, just confirm + refresh state.
        setMsg("บันทึกแล้ว (ไม่แจ้งกลุ่ม)");
        refresh();
        return;
      }
      // Saved (line qtys were already live-updated). Send the user
      // straight to the reorder/PO builder — it lists every item now
      // at/below its reorder point, grouped by supplier, ready to order.
      router.push("/staff/inventa/orders");
    } finally { setBusy(false); }
  }

  // 2026-05-31: bulk-prefill every uncounted item with its current
  // on-hand qty. Confirms first because in heavy use this can flip
  // 100s of rows from "not counted" to "counted = current_qty" in one
  // tap — the staff should explicitly choose to do it.
  async function prefillFromCurrentQty() {
    if (!session) return;
    const remaining = total - done;
    if (remaining <= 0) {
      setMsg("ทุกรายการนับครบแล้ว — ไม่มีอะไรให้กรอกเพิ่ม");
      return;
    }
    const ok = await confirm({
      title: `จะใช้ "จำนวนคงเหลือปัจจุบัน" เป็นค่าเริ่มต้นกับ ${remaining} รายการที่ยังไม่ได้นับ`,
      body: "รายการที่นับไปแล้วจะไม่ถูกแก้ · หลังจากนี้คุณยังกดแก้ตัวเลขเป็นรายๆ ได้",
      confirmLabel: "ตกลง", cancelLabel: "ยกเลิก", variant: "default"
    });
    if (ok === null) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/inventa/counts/${session.id}/prefill`), {
        method: "POST"
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setMsg(j?.error ?? "ไม่สำเร็จ ลองอีกครั้ง");
        return;
      }
      setMsg(`✓ เติม ${j.prefilled ?? 0} รายการจากจำนวนคงเหลือปัจจุบัน`);
      refresh();
    } finally { setBusy(false); }
  }

  if (!session) {
    return (
      <>
        <div className="card text-center space-y-3 py-8">
          <p className="text-slate-600">{t("inv.cnt.noSession")}</p>
          <button type="button" onClick={startSession} disabled={busy}
            className="px-6 py-2.5 rounded-lg bg-brand text-white font-bold disabled:opacity-50">
            {busy ? t("inv.cnt.opening") : t("inv.cnt.start")}
          </button>
        </div>

        {/* Reopen the previous round (PIN) — so a mistake found after
            submit doesn't force a brand-new round. */}
        {lastSubmitted && (
          <div className="card space-y-2 border border-amber-200 bg-amber-50/60">
            <div className="text-sm font-bold text-slate-800">รอบล่าสุดที่ปิดไปแล้ว</div>
            <div className="text-xs text-slate-600">
              วันที่นับ <b>{lastSubmitted.count_date}</b>
              {lastSubmitted.submitted_at && <> · ปิดรอบเมื่อ {lastSubmitted.submitted_at} น.</>}
            </div>
            <button type="button" onClick={() => setReopenPin(true)}
              className="w-full py-2.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-bold">
              เปิดรอบนี้อีกครั้งเพื่อแก้ไข (ใส่ PIN)
            </button>
            <p className="text-[11px] text-amber-700/80">
              ตัวเลขที่นับไว้ยังอยู่ครบ · ระบบจะบันทึก log ว่าใครเปิดรอบใหม่
            </p>
          </div>
        )}

        {reopenPin && lastSubmitted && (
          <PinPromptModal
            title="เปิดรอบเช็คสต๊อคอีกครั้ง"
            description={<>ยืนยันเปิดรอบวันที่ <b>{lastSubmitted.count_date}</b> อีกครั้งเพื่อแก้ไข — จะถูกบันทึก log</>}
            submitLabel="เปิดรอบ"
            onSubmit={reopenLast}
            onClose={() => setReopenPin(false)}
          />
        )}
      </>
    );
  }

  return (
    <>
      {ConfirmDialog}
      <div className="card space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-sm text-slate-600">
            {t("inv.cnt.roundDate")} <span className="font-bold text-slate-800">{session.count_date}</span>
            {session.opened_at && (
              <span className="block text-[11px] text-slate-400">
                {session.reopened ? "เปิดรอบใหม่เมื่อ" : "เปิดรอบเมื่อ"} {session.opened_at} น.
              </span>
            )}
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
          <button type="button" onClick={() => submit(true)} disabled={busy}
            className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-600 font-bold hover:bg-slate-50 disabled:opacity-50">
            บันทึก
          </button>
          <button type="button" onClick={() => submit(false)} disabled={busy}
            className="text-sm px-4 py-2 rounded-lg bg-brand text-white font-bold disabled:opacity-50">
            {t("inv.cnt.submit")}
          </button>
        </div>

        {/* "ใช้จำนวนคงเหลือปัจจุบัน" shortcut. Sits on its own row so
            staff can see the count of remaining items + reasoning hint
            before tapping. Hidden when nothing is left to fill. */}
        {total - done > 0 && (
          <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 flex-wrap">
            <div className="text-xs text-amber-900 flex-1 min-w-0">
              <span className="font-bold">ใช้ตัวเลขเดิมจากคลังปัจจุบัน</span>
              <div className="text-[11px] text-amber-700/80 mt-0.5">
                ใช้กับรายการที่ยังไม่เปลี่ยน · นับเพิ่มเฉพาะของที่ต่างจากระบบ
              </div>
            </div>
            <button
              type="button"
              onClick={prefillFromCurrentQty}
              disabled={busy}
              className="text-xs px-3 py-2 rounded-md bg-amber-500 text-white font-bold hover:bg-amber-600 disabled:opacity-50 flex-shrink-0"
            >
              ใช้ตัวเลขเดิมจากคลังปัจจุบัน ({total - done})
            </button>
          </div>
        )}
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
          {isFractionalItem(sel) ? (
            // Fractional (liquid) count: full bottles + a 0-100% slider for
            // the open bottle (owner 2026-06-16). Total bottles → `qty`.
            <div className="space-y-2">
              <label className="label">นับสต๊อก (ขวด)</label>
              <div className="flex items-center gap-2 text-sm flex-wrap">
                <input className="input !w-24 text-center text-lg font-bold" type="number" min="0"
                  value={fullBottles} placeholder="0"
                  onChange={(e) => syncFracToQty(e.target.value, openPct)} />
                <span className="text-slate-600">ขวดเต็ม</span>
                <span className="text-slate-400">+</span>
                <span className="font-bold text-brand text-base">{openPct}%</span>
                <span className="text-slate-500 text-xs">ของขวดที่เปิดใช้</span>
              </div>
              <div>
                <div className="text-[11px] text-slate-500 mb-1">ลากเลือก % ของขวดที่เปิดใช้อยู่</div>
                <input type="range" min={0} max={100} step={5} value={openPct}
                  onChange={(e) => syncFracToQty(fullBottles, Number(e.target.value))}
                  className="w-full accent-brand" />
                <div className="flex justify-between text-[10px] text-slate-400">
                  <span>0%</span><span>50%</span><span>เต็ม 100%</span>
                </div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-sm text-center">
                รวม = <span className="font-bold text-amber-800">{formatFracQty(Number(qty) || 0)}</span>
                <span className="text-slate-400 text-xs"> (≈ {(Number(qty) || 0).toFixed(2)} ขวด)</span>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="label">
                  {t("inv.cnt.qtyLabel", { unit: sel.unit ?? t("inv.ord.unit") })}
                </label>
                <input className="input text-lg font-bold" type="number" min="0"
                  autoFocus value={qty} placeholder={t("inv.cnt.qtyPh")}
                  onChange={(e) => setQty(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveLine(); }} />
              </div>

              {/* Pack-entry aid (N5) — count in packs + loose; computes the
                  base-unit qty that's actually saved. */}
              {hasPack(sel) && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 space-y-1.5">
                  <div className="text-[11px] text-emerald-800 font-semibold">
                    กรอกเป็นแพ็คได้ · {packRelationCaption(sel, sel.unit)}
                  </div>
                  <div className="flex items-center gap-2 text-sm flex-wrap">
                    <input className="input !w-20 text-center" type="number" min="0"
                      value={packIn} placeholder="0"
                      onChange={(e) => syncPackToQty(e.target.value, looseIn)} />
                    <span className="text-slate-600">{sel.pack_unit}</span>
                    <span className="text-slate-400">+</span>
                    <input className="input !w-20 text-center" type="number" min="0"
                      value={looseIn} placeholder="0"
                      onChange={(e) => syncPackToQty(packIn, e.target.value)} />
                    <span className="text-slate-600">{sel.unit}</span>
                    <span className="text-slate-400">=</span>
                    <span className="font-bold text-emerald-700">
                      {(Number(qty) || 0).toLocaleString("th-TH")} {sel.unit}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Condition / expiry flag (owner 2026-06-06) — tap if this item
              on the shelf is near-expiry, expired, or deteriorated. Sends
              a LINE alert to the INVENTA group. */}
          <div>
            <div className="text-[11px] text-slate-500 mb-1.5">พบปัญหาสินค้าชิ้นนี้? แจ้งกลุ่มไลน์:</div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" disabled={busy} onClick={() => reportStatus("expiring_60")}
                className="text-xs py-2 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50">
                ใกล้หมดอายุ ≤60 วัน
              </button>
              <button type="button" disabled={busy} onClick={() => reportStatus("expiring_30")}
                className="text-xs py-2 rounded-lg border border-orange-300 text-orange-700 hover:bg-orange-50 disabled:opacity-50">
                ใกล้หมดอายุ ≤30 วัน
              </button>
              <button type="button" disabled={busy} onClick={() => reportStatus("expired")}
                className="text-xs py-2 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 disabled:opacity-50">
                หมดอายุแล้ว
              </button>
              <button type="button" disabled={busy} onClick={() => reportStatus("deteriorated")}
                className="text-xs py-2 rounded-lg border border-violet-300 text-violet-700 hover:bg-violet-50 disabled:opacity-50">
                เสื่อมสภาพ
              </button>
            </div>
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

        {/* Filters — like the catalogue page: pick frequency + category,
            plus a count-only "เฉพาะที่ยังไม่นับ" toggle. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            <button type="button" onClick={() => setFreqFilter("")}
              className={`text-xs px-2.5 py-1 rounded-full border ${freqFilter === "" ? "bg-slate-800 text-white border-slate-800" : "border-slate-300 text-slate-600"}`}>
              ทั้งหมด
            </button>
            {(["R", "Y", "G"] as PickFreq[]).map((f) => {
              const active = freqFilter === f;
              return (
                <button key={f} type="button" onClick={() => setFreqFilter(active ? "" : f)}
                  className={`text-xs px-2.5 py-1 rounded-full border inline-flex items-center gap-1 ${active ? "bg-slate-800 text-white border-slate-800" : "border-slate-300 text-slate-600"}`}>
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${PICK_FREQ_META[f].dot}`} />
                  {PICK_FREQ_META[f].short}
                </button>
              );
            })}
          </div>
          {categories.length > 0 && (
            <select className="input !w-auto max-w-[42vw] sm:max-w-[220px] text-sm" value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}>
              <option value="">ทุกหมวด</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {supplierOptions.length > 0 && (
            <select className="input !w-auto max-w-[42vw] sm:max-w-[220px] text-sm" value={supFilter}
              onChange={(e) => setSupFilter(e.target.value)}>
              <option value="">ทุกผู้จำหน่าย</option>
              {supplierOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          {locationOptions.length > 0 && (
            <select className="input !w-auto max-w-[42vw] sm:max-w-[220px] text-sm" value={locFilter}
              onChange={(e) => setLocFilter(e.target.value)}>
              <option value="">ทุกตำแหน่ง</option>
              {locationOptions.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          )}
          <button type="button" onClick={() => setUncountedOnly((v) => !v)}
            className={`text-xs px-2.5 py-1 rounded-full border ${uncountedOnly ? "bg-slate-800 text-white border-slate-800" : "border-slate-300 text-slate-600"}`}>
            เฉพาะที่ยังไม่นับ
          </button>
        </div>
        <div className="text-[11px] text-slate-400">แสดง {filtered.length} / {total} รายการ</div>

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
                    ? <span className="text-emerald-600 font-bold">{t("inv.cnt.countedTag", { n: isFractionalItem(i) ? formatFracQty(c) : c })}</span>
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
