"use client";

import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";

// Minimal, functional customer ordering flow inside LIFF. Steps:
//   branch → menu + cart → checkout (address/geolocation + quote) → done.
// Prices + delivery fee shown here are for display; the server recomputes both
// on create. UI is Thai-first; runs behind the customer channel (dark until env
// + delivera_enabled are set). window.liff is typed globally in lib/liff-types.

type Branch = { id: number; name: string };
type MenuItem = { id: number; name_th: string; category: string | null; price: number; image_url: string | null };
type Quote = { deliveryFee: number; distanceKm: number; minOrder: number; meetsMin: boolean; zoneName: string };

type Phase = "loading" | "branch" | "menu" | "checkout" | "done" | "error";

export default function OrderClient({ liffId, lockedBranchId = 0 }: { liffId: string; lockedBranchId?: number }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string>("");
  const [displayName, setDisplayName] = useState<string>("");

  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [cart, setCart] = useState<Record<number, number>>({});
  const [zoomImg, setZoomImg] = useState<{ url: string; name: string } | null>(null);

  const [fulfillment, setFulfillment] = useState<"delivery" | "pickup">("delivery");
  const [address, setAddress] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [timeSlot, setTimeSlot] = useState("");
  const [note, setNote] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [orderNo, setOrderNo] = useState<string | null>(null);

  // ── LIFF init ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      if (!liffId) { setErr("ยังไม่ได้ตั้งค่า LIFF ลูกค้า (แอดมิน → DELIVERA → เชื่อมต่อ LINE)"); setPhase("error"); return; }
      // wait for the CDN SDK
      for (let i = 0; i < 100 && !window.liff; i++) await new Promise((r) => setTimeout(r, 50));
      const liff = window.liff;
      if (!liff) { setErr("โหลด LINE SDK ไม่สำเร็จ"); setPhase("error"); return; }
      try {
        await liff.init({ liffId });
        if (!liff.isLoggedIn()) { liff.login(); return; }
        const token = liff.getAccessToken();
        const prof = await liff.getProfile();
        if (cancelled) return;
        setAccessToken(token ?? "");
        setDisplayName(prof?.displayName ?? "");
        // Branch-scoped link (?branch=<id>) → jump straight to that shop's menu.
        if (lockedBranchId) { await loadMenu(lockedBranchId); return; }
        const res = await fetch(apiUrl("/api/delivera/branches"));
        const j = await res.json();
        setBranches(j.branches ?? []);
        setPhase("branch");
      } catch (e) {
        setErr("เริ่มต้น LIFF ไม่สำเร็จ: " + (e as Error).message);
        setPhase("error");
      }
    }
    boot();
    return () => { cancelled = true; };
  }, [liffId, lockedBranchId]);

  async function loadMenu(id: number) {
    setBranchId(id);
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/delivera/menu?branch=${id}`));
      const j = await res.json();
      setMenu(j.menu ?? []);
      setCart({});
      setPhase("menu");
    } finally { setBusy(false); }
  }

  const subtotal = useMemo(
    () => menu.reduce((s, m) => s + (cart[m.id] ?? 0) * m.price, 0),
    [menu, cart]
  );
  const cartCount = useMemo(() => Object.values(cart).reduce((s, n) => s + n, 0), [cart]);

  function setQty(id: number, delta: number) {
    setCart((c) => {
      const next = Math.max(0, (c[id] ?? 0) + delta);
      const copy = { ...c };
      if (next === 0) delete copy[id]; else copy[id] = next;
      return copy;
    });
  }

  function grabLocation() {
    if (!navigator.geolocation) { setQuoteErr("อุปกรณ์ไม่รองรับการดึงพิกัด"); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setQuoteErr("ดึงพิกัดไม่สำเร็จ — กรุณาอนุญาตตำแหน่ง"),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function refreshQuote() {
    setQuoteErr(null); setQuote(null);
    if (fulfillment === "pickup" || !branchId || !coords) return;
    const res = await fetch(apiUrl("/api/delivera/quote"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch_id: branchId, dest_lat: coords.lat, dest_lng: coords.lng, subtotal })
    });
    const j = await res.json();
    if (!res.ok || !j.ok) {
      setQuoteErr(j.error === "out_of_zone" ? "อยู่นอกเขตจัดส่งของสาขานี้" : (j.error ?? "ประเมินค่าส่งไม่สำเร็จ"));
      return;
    }
    setQuote({ deliveryFee: j.quote.deliveryFee, distanceKm: j.quote.distanceKm, minOrder: j.quote.minOrder, meetsMin: j.quote.meetsMin, zoneName: j.quote.zoneName });
  }
  useEffect(() => { if (phase === "checkout") refreshQuote(); /* eslint-disable-next-line */ }, [phase, coords, fulfillment, subtotal]);

  const deliveryFee = fulfillment === "delivery" ? (quote?.deliveryFee ?? 0) : 0;
  const total = subtotal + deliveryFee;
  const canSubmit =
    cartCount > 0 && !busy &&
    (fulfillment === "pickup" ||
      (!!coords && !!quote && quote.meetsMin));

  async function submit() {
    if (!branchId) return;
    setBusy(true); setErr(null);
    try {
      const body = {
        branch_id: branchId, access_token: accessToken, customer_display_name: displayName || null,
        fulfillment, dest_address: fulfillment === "delivery" ? address || null : null,
        dest_lat: coords?.lat ?? null, dest_lng: coords?.lng ?? null,
        time_slot: timeSlot || null, note: note || null,
        items: Object.entries(cart).map(([id, qty]) => ({ menu_item_id: Number(id), qty }))
      };
      const res = await fetch(apiUrl("/api/delivera/orders"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(orderErrText(j.error)); return; }
      setOrderNo(j.order_no);
      setPhase("done");
    } finally { setBusy(false); }
  }

  // ── render ─────────────────────────────────────────────────────
  if (phase === "loading") return <Shell><p className="text-slate-500 text-sm">กำลังโหลด…</p></Shell>;
  if (phase === "error") return <Shell><p className="text-rose-600 text-sm">{err}</p></Shell>;

  if (phase === "branch") return (
    <Shell>
      <h1 className="text-lg font-bold text-slate-800 mb-1">เลือกสาขา</h1>
      <p className="text-xs text-slate-500 mb-3">สวัสดี {displayName || "ลูกค้า"} 👋</p>
      {branches.length === 0 && <p className="text-sm text-slate-400">ยังไม่มีสาขาที่เปิดบริการเดลิเวอรี</p>}
      <div className="space-y-2">
        {branches.map((b) => (
          <button key={b.id} onClick={() => loadMenu(b.id)} disabled={busy}
            className="w-full text-left px-4 py-3 rounded-xl border border-slate-200 hover:border-brand hover:bg-amber-50 font-medium text-slate-700">
            {b.name}
          </button>
        ))}
      </div>
    </Shell>
  );

  if (phase === "menu") return (
    <Shell>
      {!lockedBranchId && <button onClick={() => setPhase("branch")} className="text-xs text-slate-500 mb-2">← เปลี่ยนสาขา</button>}
      <h1 className="text-lg font-bold text-slate-800 mb-3">เมนู</h1>
      <div className="space-y-2 pb-24">
        {menu.length === 0 && <p className="text-sm text-slate-400">ยังไม่มีเมนู</p>}
        {menu.map((m) => (
          <div key={m.id} className="flex items-center gap-3 px-3 py-2 rounded-xl border border-slate-100">
            {m.image_url && (
              <button type="button" onClick={() => setZoomImg({ url: m.image_url!, name: m.name_th })}
                className="flex-none rounded-lg overflow-hidden" aria-label={`ดูรูป ${m.name_th}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={m.image_url} alt={m.name_th} className="w-14 h-14 rounded-lg object-cover" />
              </button>
            )}
            <div className="flex-1 min-w-0">
              <div className="font-medium text-slate-800 truncate">{m.name_th}</div>
              <div className="text-xs text-slate-500">฿{fmtMoney(m.price)}{m.category ? ` · ${m.category}` : ""}</div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setQty(m.id, -1)} className="w-8 h-8 rounded-full border border-slate-300 text-slate-600">−</button>
              <span className="w-6 text-center tabular-nums">{cart[m.id] ?? 0}</span>
              <button onClick={() => setQty(m.id, +1)} className="w-8 h-8 rounded-full border border-brand text-brand">+</button>
            </div>
          </div>
        ))}
      </div>
      {cartCount > 0 && (
        <div className="fixed bottom-0 inset-x-0 p-3 bg-white border-t border-slate-200">
          <button onClick={() => setPhase("checkout")}
            className="w-full py-3 rounded-xl bg-brand text-white font-bold">
            ดำเนินการต่อ · {cartCount} รายการ · ฿{fmtMoney(subtotal)}
          </button>
        </div>
      )}
      {zoomImg && (
        <div onClick={() => setZoomImg(null)}
          className="fixed inset-0 z-50 bg-black/85 flex flex-col items-center justify-center p-4" role="dialog" aria-modal="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoomImg.url} alt={zoomImg.name} className="max-w-full max-h-[80vh] rounded-xl object-contain" />
          <p className="mt-3 text-white text-sm font-medium">{zoomImg.name}</p>
          <p className="mt-1 text-white/60 text-xs">แตะที่ใดก็ได้เพื่อปิด</p>
        </div>
      )}
    </Shell>
  );

  if (phase === "checkout") return (
    <Shell>
      <button onClick={() => setPhase("menu")} className="text-xs text-slate-500 mb-2">← กลับไปเมนู</button>
      <h1 className="text-lg font-bold text-slate-800 mb-3">ยืนยันคำสั่งซื้อ</h1>

      <div className="flex gap-2 mb-3">
        {(["delivery", "pickup"] as const).map((f) => (
          <button key={f} onClick={() => setFulfillment(f)}
            className={`flex-1 py-2 rounded-lg border text-sm font-medium ${fulfillment === f ? "bg-brand text-white border-brand" : "border-slate-300 text-slate-600"}`}>
            {f === "delivery" ? "จัดส่ง" : "รับเอง"}
          </button>
        ))}
      </div>

      {fulfillment === "delivery" && (
        <div className="space-y-2 mb-3">
          <textarea className="input" rows={2} placeholder="ที่อยู่จัดส่ง" value={address} onChange={(e) => setAddress(e.target.value)} />
          <button onClick={grabLocation} className="w-full py-2 rounded-lg border border-brand text-brand text-sm font-medium">
            📍 {coords ? `ปักพิกัดแล้ว (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})` : "ดึงพิกัดปัจจุบัน"}
          </button>
          {quoteErr && <p className="text-xs text-rose-600">{quoteErr}</p>}
          {quote && (
            <p className="text-xs text-slate-500">
              เขต {quote.zoneName} · {quote.distanceKm} กม. · ค่าส่ง ฿{fmtMoney(quote.deliveryFee)}
              {!quote.meetsMin && <span className="text-rose-600"> · ขั้นต่ำ ฿{fmtMoney(quote.minOrder)}</span>}
            </p>
          )}
        </div>
      )}

      <input className="input mb-2" placeholder="ช่วงเวลาที่ต้องการ (เช่น 12:00–12:30)" value={timeSlot} onChange={(e) => setTimeSlot(e.target.value)} />
      <input className="input mb-3" placeholder="หมายเหตุถึงร้าน (ถ้ามี)" value={note} onChange={(e) => setNote(e.target.value)} />

      <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-sm space-y-1 mb-3">
        <Row label="ยอดอาหาร" value={`฿${fmtMoney(subtotal)}`} />
        {fulfillment === "delivery" && <Row label="ค่าส่ง" value={`฿${fmtMoney(deliveryFee)}`} />}
        <div className="border-t border-slate-200 pt-1 flex justify-between font-bold text-slate-800">
          <span>รวมทั้งสิ้น</span><span>฿{fmtMoney(total)}</span>
        </div>
      </div>

      {err && <p className="text-sm text-rose-600 mb-2">{err}</p>}
      <button onClick={submit} disabled={!canSubmit}
        className="w-full py-3 rounded-xl bg-brand text-white font-bold disabled:opacity-40">
        {busy ? "กำลังส่ง…" : "ยืนยันสั่งซื้อ"}
      </button>
    </Shell>
  );

  // done
  return (
    <Shell>
      <div className="text-center py-8">
        <div className="text-4xl mb-2">✅</div>
        <h1 className="text-lg font-bold text-slate-800">รับออเดอร์แล้ว</h1>
        <p className="text-sm text-slate-500 mt-1">เลขที่ {orderNo}</p>
        <p className="text-xs text-slate-400 mt-2">ขั้นตอนถัดไป: ชำระเงิน (PromptPay / เก็บปลายทาง)</p>
        {orderNo && (
          <a href={`/delivera/track/${orderNo}`} className="inline-block mt-4 px-5 py-2 rounded-lg border border-brand text-brand text-sm font-bold">
            ติดตามสถานะ
          </a>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="max-w-md mx-auto min-h-screen bg-white px-4 py-5">{children}</div>;
}
function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between text-slate-600"><span>{label}</span><span>{value}</span></div>;
}
function orderErrText(code: string): string {
  const m: Record<string, string> = {
    below_min_order: "ยอดสั่งซื้อต่ำกว่าขั้นต่ำของเขตจัดส่ง",
    dest_location_required: "กรุณาปักพิกัดที่อยู่จัดส่ง",
    menu_item_unavailable: "มีเมนูที่ปิดการขายอยู่ในตะกร้า",
    delivera_line_not_configured: "ระบบยังไม่พร้อมให้บริการ",
    line_auth_failed: "ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาลองใหม่"
  };
  return m[code] ?? "สั่งซื้อไม่สำเร็จ กรุณาลองใหม่";
}
