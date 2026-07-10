"use client";

import { useRef, useState } from "react";
import { apiUrl } from "@/lib/url";

type MenuItem = { id: number; name_th: string; category: string | null; price: number; is_available: boolean; image_url: string | null };
type Zone = { id: number; name: string; max_distance_km: number; base_fee: number; per_km_fee: number; min_order_amount: number };
type Hooks = { deduct_stock: boolean; post_income: boolean; record_insigna: boolean };

async function post(url: string, body: unknown, method: "POST" | "PATCH" | "DELETE" = "POST") {
  const res = await fetch(apiUrl(url), { method, headers: { "Content-Type": "application/json" }, body: method === "DELETE" ? undefined : JSON.stringify(body) });
  return res.ok;
}

/** Small square image picker: shows the current image (or a + placeholder),
 *  uploads a picked file via multipart to `endpoint`, and clears via DELETE.
 *  Returns the new public url (or null on remove) through onChange. */
function ImagePick({ url, endpoint, onChange, size = 56, label = "รูป" }: {
  url: string | null; endpoint: string; onChange: (u: string | null) => void; size?: number; label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function upload(file: File) {
    setBusy(true);
    try {
      const fd = new FormData(); fd.append("file", file);
      const res = await fetch(apiUrl(endpoint), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) onChange(j.image_url ?? j.promptpay_qr_url ?? null);
      else alert(j.message || "อัปโหลดไม่สำเร็จ");
    } finally { setBusy(false); }
  }
  async function remove() { setBusy(true); try { if (await post(endpoint, {}, "DELETE")) onChange(null); } finally { setBusy(false); } }
  return (
    <div className="flex items-center gap-1.5">
      <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}
        className="relative rounded-lg border border-dashed border-slate-300 bg-slate-50 overflow-hidden flex items-center justify-center text-slate-400 disabled:opacity-50"
        style={{ width: size, height: size }} title={`อัปโหลด${label}`}>
        {url
          /* eslint-disable-next-line @next/next/no-img-element */
          ? <img src={url} alt={label} className="w-full h-full object-cover" />
          : <span className="text-lg leading-none">＋</span>}
      </button>
      {url && <button type="button" onClick={remove} disabled={busy} className="text-[11px] text-rose-500 hover:underline">ลบ{label}</button>}
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
    </div>
  );
}

export default function SettingsClient(props: {
  enabled: boolean; promptpayId: string | null; promptpayQrUrl: string | null; codEnabled: boolean; prepMinutes: number; hooks: Hooks; hasCoords: boolean;
  menu: MenuItem[]; zones: Zone[];
}) {
  const [enabled, setEnabled] = useState(props.enabled);
  const [promptpay, setPromptpay] = useState(props.promptpayId ?? "");
  const [qrUrl, setQrUrl] = useState(props.promptpayQrUrl);
  const [cod, setCod] = useState(props.codEnabled);
  const [prep, setPrep] = useState(String(props.prepMinutes));
  const [hooks, setHooks] = useState(props.hooks);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>(props.menu);
  const [zones, setZones] = useState<Zone[]>(props.zones);

  async function saveSettings(patch: Record<string, unknown>) {
    if (await post("/api/admin/delivera/settings", patch)) { setSavedMsg("บันทึกแล้ว"); setTimeout(() => setSavedMsg(null), 1500); }
  }

  return (
    <div className="space-y-4">
      {/* ── Settings ── */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-bold text-slate-800">เปิดใช้งาน DELIVERA (สาขานี้)</h2>
            <p className="text-[11px] text-slate-400">เปิดเมื่อพร้อม (ตั้ง PromptPay + เมนู + โซนแล้ว)</p>
          </div>
          <button type="button" onClick={() => { const v = !enabled; setEnabled(v); saveSettings({ enabled: v }); }}
            className={`rounded-full px-4 py-1.5 text-sm font-medium ${enabled ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600"}`}>
            {enabled ? "เปิดอยู่" : "ปิดอยู่"}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label !text-xs">เลข PromptPay (เบอร์/เลขบัตร) สำหรับสร้าง QR</label>
            <input className="input font-mono" value={promptpay} onChange={(e) => setPromptpay(e.target.value)} onBlur={() => saveSettings({ promptpay_id: promptpay.trim() || null })} placeholder="0812345678 หรือ 13 หลัก" />
          </div>
          <div>
            <label className="label !text-xs">เวลาทำอาหารโดยประมาณ (นาที)</label>
            <input type="number" min={1} className="input" value={prep} onChange={(e) => setPrep(e.target.value)} onBlur={() => saveSettings({ default_prep_minutes: Number(prep) || 20 })} />
          </div>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
          <div>
            <div className="text-sm font-medium text-slate-700">รับเงินปลายทาง (COD)</div>
            <p className="text-[11px] text-slate-400">{cod ? "ลูกค้าเลือกจ่ายปลายทางได้" : "ปิดอยู่ — ลูกค้าต้องจ่ายผ่าน PromptPay เท่านั้น"}</p>
          </div>
          <button type="button" onClick={() => { const v = !cod; setCod(v); saveSettings({ cod_enabled: v }); }}
            className={`rounded-full px-4 py-1.5 text-sm font-medium ${cod ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600"}`}>
            {cod ? "เปิด" : "ปิด"}
          </button>
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5 flex items-center gap-3">
          <ImagePick url={qrUrl} endpoint="/api/admin/delivera/settings/qr" onChange={setQrUrl} size={72} label="QR" />
          <div className="text-[11px] text-slate-500">
            <div className="font-medium text-slate-700">ภาพ QR PromptPay ของร้าน (ถ้ามี)</div>
            {qrUrl ? "ลูกค้าจะเห็นภาพ QR นี้ตอนชำระเงิน (ใช้แทน QR อัตโนมัติ)" : "อัปโหลดภาพ QR ของร้าน หรือปล่อยว่างเพื่อสร้าง QR อัตโนมัติจากเลข PromptPay ด้านบน"}
          </div>
        </div>
        {!props.hasCoords && (
          <p className="text-[11px] text-amber-700">⚠ ยังไม่ได้ตั้งพิกัดร้าน — ไปตั้งที่ PERSONA → ตั้งค่าสาขา (ใช้คำนวณระยะทีมงานส่งสุข)</p>
        )}
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer">ตัวเลือกขั้นสูง: เชื่อมระบบอัตโนมัติ (ปิดไว้เป็นค่าเริ่มต้น)</summary>
          <div className="mt-2 space-y-1.5">
            {([["deduct_stock", "ตัดสต็อก INVENTA ตอนเริ่มทำ"], ["post_income", "ลงรายรับ ACCOUNTA ตอนเสร็จ (ระวังซ้ำกับปิดกะ)"], ["record_insigna", "บันทึกลูกค้าเข้า INSIGNA"]] as const).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" checked={hooks[k]} onChange={(e) => { const h = { ...hooks, [k]: e.target.checked }; setHooks(h); saveSettings({ [`hook_${k}`]: e.target.checked }); }} />
                {label}
              </label>
            ))}
          </div>
        </details>
        {savedMsg && <p className="text-[11px] text-emerald-700">{savedMsg}</p>}
      </div>

      {/* ── Menu ── */}
      <MenuManager menu={menu} setMenu={setMenu} />

      {/* ── Zones ── */}
      <ZoneManager zones={zones} setZones={setZones} />
    </div>
  );
}

function MenuManager({ menu, setMenu }: { menu: MenuItem[]; setMenu: (m: MenuItem[]) => void }) {
  const [name, setName] = useState(""); const [cat, setCat] = useState(""); const [price, setPrice] = useState("");
  async function add() {
    if (!name.trim() || !(Number(price) >= 0)) return;
    const res = await fetch(apiUrl("/api/admin/delivera/menu"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name_th: name.trim(), category: cat.trim() || null, price: Number(price) }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) { setMenu([...menu, { id: j.id, name_th: name.trim(), category: cat.trim() || null, price: Number(price), is_available: true, image_url: null }]); setName(""); setCat(""); setPrice(""); }
  }
  function setImage(it: MenuItem, url: string | null) { setMenu(menu.map((m) => m.id === it.id ? { ...m, image_url: url } : m)); }
  async function toggle(it: MenuItem) { if (await post(`/api/admin/delivera/menu/${it.id}`, { is_available: !it.is_available }, "PATCH")) setMenu(menu.map((m) => m.id === it.id ? { ...m, is_available: !m.is_available } : m)); }
  async function setPriceItem(it: MenuItem, p: number) { if (await post(`/api/admin/delivera/menu/${it.id}`, { price: p }, "PATCH")) setMenu(menu.map((m) => m.id === it.id ? { ...m, price: p } : m)); }
  async function del(it: MenuItem) { if (await post(`/api/admin/delivera/menu/${it.id}`, {}, "DELETE")) setMenu(menu.filter((m) => m.id !== it.id)); }
  return (
    <div className="card space-y-2">
      <h2 className="font-bold text-slate-800">เมนู ({menu.length})</h2>
      <div className="space-y-1.5">
        {menu.map((it) => (
          <div key={it.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5">
            <ImagePick url={it.image_url} endpoint={`/api/admin/delivera/menu/${it.id}/image`} onChange={(u) => setImage(it, u)} size={44} label="รูป" />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-slate-700 truncate">{it.name_th}{it.category ? <span className="text-slate-400"> · {it.category}</span> : null}</div>
            </div>
            <input type="number" min={0} className="input !w-24 !py-1 text-right font-mono" defaultValue={it.price}
              onBlur={(e) => { const p = Number(e.target.value); if (p !== it.price && p >= 0) setPriceItem(it, p); }} />
            <label className="flex items-center gap-1 text-[11px] text-slate-500"><input type="checkbox" checked={it.is_available} onChange={() => toggle(it)} />ขาย</label>
            <button type="button" onClick={() => del(it)} className="text-[11px] text-rose-500 hover:underline">ลบ</button>
          </div>
        ))}
        {menu.length === 0 && <p className="text-sm text-slate-400">ยังไม่มีเมนู — เพิ่มด้านล่าง</p>}
      </div>
      <div className="flex items-end gap-2 pt-1">
        <div className="flex-1"><label className="label !text-xs">ชื่อเมนู</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ข้าวผัดกะเพรา" /></div>
        <div className="w-28"><label className="label !text-xs">หมวด</label><input className="input" value={cat} onChange={(e) => setCat(e.target.value)} placeholder="อาหาร" /></div>
        <div className="w-24"><label className="label !text-xs">ราคา</label><input type="number" min={0} className="input text-right font-mono" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
        <button type="button" onClick={add} disabled={!name.trim()} className="rounded-md bg-brand text-white px-3 py-2 text-sm font-medium disabled:opacity-50">เพิ่ม</button>
      </div>
    </div>
  );
}

function ZoneManager({ zones, setZones }: { zones: Zone[]; setZones: (z: Zone[]) => void }) {
  const [z, setZ] = useState({ name: "", max: "", base: "", perkm: "", min: "" });
  async function add() {
    const body = { name: z.name.trim(), max_distance_km: Number(z.max), base_fee: Number(z.base), per_km_fee: Number(z.perkm) || 0, min_order_amount: Number(z.min) || 0 };
    if (!body.name || !(body.max_distance_km > 0)) return;
    const res = await fetch(apiUrl("/api/admin/delivera/zones"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) { setZones([...zones, { id: j.id, ...body }]); setZ({ name: "", max: "", base: "", perkm: "", min: "" }); }
  }
  async function patch(zn: Zone, field: keyof Zone, val: number | string) { if (await post(`/api/admin/delivera/zones/${zn.id}`, { [field]: val }, "PATCH")) setZones(zones.map((x) => x.id === zn.id ? { ...x, [field]: val } : x)); }
  async function del(zn: Zone) { if (await post(`/api/admin/delivera/zones/${zn.id}`, {}, "DELETE")) setZones(zones.filter((x) => x.id !== zn.id)); }
  const num = (zn: Zone, field: "max_distance_km" | "base_fee" | "per_km_fee" | "min_order_amount") => (
    <input type="number" min={0} className="input !w-20 !py-1 text-right font-mono" defaultValue={zn[field]}
      onBlur={(e) => { const v = Number(e.target.value); if (v !== zn[field] && v >= 0) patch(zn, field, v); }} />
  );
  return (
    <div className="card space-y-2">
      <h2 className="font-bold text-slate-800">โซนส่ง / ค่าส่ง</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-[11px] text-slate-400 border-b border-slate-100"><th className="text-left py-1">ชื่อโซน</th><th>≤ กม.</th><th>ค่าส่งพื้นฐาน</th><th>+/กม.</th><th>ขั้นต่ำ</th><th></th></tr></thead>
          <tbody>
            {zones.map((zn) => (
              <tr key={zn.id} className="border-b border-slate-50">
                <td className="py-1 pr-2"><input className="input !py-1" defaultValue={zn.name} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== zn.name) patch(zn, "name", e.target.value.trim()); }} /></td>
                <td className="text-center">{num(zn, "max_distance_km")}</td>
                <td className="text-center">{num(zn, "base_fee")}</td>
                <td className="text-center">{num(zn, "per_km_fee")}</td>
                <td className="text-center">{num(zn, "min_order_amount")}</td>
                <td className="text-right"><button type="button" onClick={() => del(zn)} className="text-[11px] text-rose-500 hover:underline">ลบ</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-end gap-2 pt-1 flex-wrap">
        <div className="flex-1 min-w-[8rem]"><label className="label !text-xs">ชื่อโซนใหม่</label><input className="input" value={z.name} onChange={(e) => setZ({ ...z, name: e.target.value })} placeholder="เช่น ในเมือง" /></div>
        <div className="w-16"><label className="label !text-xs">≤ กม.</label><input type="number" className="input text-right font-mono" value={z.max} onChange={(e) => setZ({ ...z, max: e.target.value })} /></div>
        <div className="w-20"><label className="label !text-xs">ค่าส่ง</label><input type="number" className="input text-right font-mono" value={z.base} onChange={(e) => setZ({ ...z, base: e.target.value })} /></div>
        <div className="w-16"><label className="label !text-xs">+/กม.</label><input type="number" className="input text-right font-mono" value={z.perkm} onChange={(e) => setZ({ ...z, perkm: e.target.value })} /></div>
        <div className="w-20"><label className="label !text-xs">ขั้นต่ำ</label><input type="number" className="input text-right font-mono" value={z.min} onChange={(e) => setZ({ ...z, min: e.target.value })} /></div>
        <button type="button" onClick={add} disabled={!z.name.trim()} className="rounded-md bg-brand text-white px-3 py-2 text-sm font-medium disabled:opacity-50">เพิ่มโซน</button>
      </div>
    </div>
  );
}
