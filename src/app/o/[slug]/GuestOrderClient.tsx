"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { fmtMoney } from "@/lib/format";
import { apiUrl } from "@/lib/url";

type Choice = { id: number; name: string; priceDelta: number; available: boolean };
type Group = { id: number; name: string; minPick: number; maxPick: number; choices: Choice[] };
export type GuestMenuItem = { id: number; name: string; description: string | null; price: number; image: string | null; category: string; options: Group[] };
type Line = { key: string; item: GuestMenuItem; choiceIds: number[]; qty: number };

const unitPrice = (it: GuestMenuItem, ids: number[]) => it.price + it.options.flatMap((g) => g.choices).filter((c) => ids.includes(c.id)).reduce((s, c) => s + c.priceDelta, 0);
const describe = (it: GuestMenuItem, ids: number[]) => it.options.map((g) => { const n = g.choices.filter((c) => ids.includes(c.id)).map((c) => c.name); return n.length ? `${g.name}: ${n.join(", ")}` : ""; }).filter(Boolean).join(" · ");
const lineKey = (id: number, ids: number[]) => `${id}:${[...ids].sort((a, b) => a - b).join(",")}`;

// Customer ordering from the table / counter QR (owner 2026-10-30, after the KOI Alipay mini-program): browse by category,
// pick options, add to the basket, send the order — then follow it on the tracking page. Prices shown here are for display;
// the server recomputes every price.
export default function GuestOrderClient({ branch, table, items }: { branch: { id: number; name: string }; table: string | null; items: GuestMenuItem[] }) {
  const router = useRouter();
  const categories = useMemo(() => [...new Set(items.map((i) => i.category))], [items]);
  const [cat, setCat] = useState<string>(categories[0] ?? "");
  const [lines, setLines] = useState<Line[]>([]);
  const [sheet, setSheet] = useState<GuestMenuItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [stats, setStats] = useState<{ inProgress: number; estMinutes: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => { try { const r = await fetch(apiUrl(`/api/o/status?branch=${branch.id}`), { cache: "no-store" }); const j = await r.json(); if (alive && j.ok) setStats({ inProgress: j.inProgress, estMinutes: j.estMinutes }); } catch { /* keep the last value */ } };
    void load(); const t = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, [branch.id]);

  const count = lines.reduce((s, l) => s + l.qty, 0);
  const total = lines.reduce((s, l) => s + unitPrice(l.item, l.choiceIds) * l.qty, 0);
  const add = (item: GuestMenuItem, ids: number[], qty: number) => setLines((ls) => {
    const key = lineKey(item.id, ids); const hit = ls.find((l) => l.key === key);
    return hit ? ls.map((l) => (l.key === key ? { ...l, qty: l.qty + qty } : l)) : [...ls, { key, item, choiceIds: ids, qty }];
  });
  const bump = (key: string, d: number) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, qty: l.qty + d } : l)).filter((l) => l.qty > 0));

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(apiUrl("/api/o/order"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        branch_id: branch.id, table, name: name || null, phone: phone || null, note: note || null,
        items: lines.map((l) => ({ menu_item_id: l.item.id, qty: l.qty, choice_ids: l.choiceIds }))
      }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setErr(j.message ?? "สั่งไม่สำเร็จ กรุณาลองใหม่"); return; }
      router.push(`/o/t/${j.token}`);
    } finally { setBusy(false); }
  }

  const shown = items.filter((i) => i.category === cat);
  return (
    <div className="mx-auto max-w-lg min-h-screen bg-[#faf7f2] pb-28">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-200 px-4 pt-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0"><div className="font-bold text-slate-800 truncate">{branch.name}</div>
            <div className="text-xs text-slate-500">{table ? `โต๊ะ ${table}` : "สั่งรับที่ร้าน"}</div></div>
          {stats && <div className="shrink-0 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-[11px] px-2.5 py-1">● กำลังทำ {stats.inProgress} ออเดอร์ · รอประมาณ {stats.estMinutes} นาที</div>}
        </div>
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          {categories.map((c) => <button key={c} type="button" onClick={() => setCat(c)} className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm ${cat === c ? "bg-brand text-white border-brand" : "bg-white text-slate-600 border-slate-200"}`}>{c}</button>)}
        </div>
      </header>

      <main className="px-4 py-3 space-y-2.5">
        {items.length === 0 && <p className="text-center text-sm text-slate-400 py-12">ยังไม่มีเมนูที่เปิดขาย</p>}
        {shown.map((it) => (
          <div key={it.id} className="flex gap-3 rounded-2xl bg-white border border-slate-100 p-3 shadow-sm">
            {it.image && /* eslint-disable-next-line @next/next/no-img-element */ <img src={it.image} alt={it.name} className="h-24 w-24 shrink-0 rounded-xl object-cover" />}
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="font-semibold text-slate-800">{it.name}</div>
              {it.description && <div className="text-xs text-slate-500 line-clamp-2 mt-0.5">{it.description}</div>}
              <div className="mt-auto flex items-end justify-between pt-2">
                <div className="text-lg font-bold text-slate-800">฿{fmtMoney(it.price)}{it.options.some((g) => g.choices.some((c) => c.priceDelta > 0)) && <span className="text-xs font-normal text-slate-400"> ขึ้นไป</span>}</div>
                <button type="button" onClick={() => (it.options.length > 0 ? setSheet(it) : add(it, [], 1))}
                  className="rounded-full bg-brand text-white text-sm font-semibold px-4 py-1.5">{it.options.length > 0 ? "เลือก" : "+ เพิ่ม"}</button>
              </div>
            </div>
          </div>
        ))}
      </main>

      {count > 0 && !cartOpen && (
        <div className="fixed bottom-0 inset-x-0 z-30 mx-auto max-w-lg p-3">
          <button type="button" onClick={() => setCartOpen(true)} className="w-full flex items-center justify-between rounded-2xl bg-brand text-white font-bold px-5 py-3.5 shadow-lg">
            <span>ตะกร้า · {count} รายการ</span><span>฿{fmtMoney(total)}</span>
          </button>
        </div>
      )}

      {sheet && <OptionSheet item={sheet} onClose={() => setSheet(null)} onAdd={(ids, qty) => { add(sheet, ids, qty); setSheet(null); }} />}

      {cartOpen && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50" onClick={() => setCartOpen(false)}>
          <div className="bg-white w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between"><h2 className="text-lg font-bold text-slate-800">ตะกร้าของฉัน</h2><button type="button" className="text-slate-400 text-2xl leading-none" onClick={() => setCartOpen(false)} aria-label="ปิด">×</button></div>
            {lines.length === 0 ? <p className="text-sm text-slate-400 py-6 text-center">ตะกร้าว่าง</p> : (
              <ul className="divide-y divide-slate-100">
                {lines.map((l) => (
                  <li key={l.key} className="py-3 flex items-start gap-3">
                    <div className="flex-1 min-w-0"><div className="font-medium text-slate-800">{l.item.name}</div>
                      {describe(l.item, l.choiceIds) && <div className="text-xs text-slate-500">{describe(l.item, l.choiceIds)}</div>}
                      <div className="text-sm text-slate-600 mt-0.5">฿{fmtMoney(unitPrice(l.item, l.choiceIds) * l.qty)}</div></div>
                    <div className="flex items-center gap-2"><button type="button" onClick={() => bump(l.key, -1)} className="h-8 w-8 rounded-full border border-slate-300 text-slate-600" aria-label="ลด">−</button><span className="w-5 text-center tabular-nums">{l.qty}</span><button type="button" onClick={() => bump(l.key, 1)} className="h-8 w-8 rounded-full border border-brand text-brand" aria-label="เพิ่ม">+</button></div>
                  </li>
                ))}
              </ul>
            )}
            <div className="space-y-2">
              <input className="input w-full" placeholder="ชื่อ (ไว้เรียกรับ ไม่บังคับ)" value={name} onChange={(e) => setName(e.target.value)} />
              <input className="input w-full" inputMode="tel" placeholder="เบอร์โทร (ไม่บังคับ)" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <input className="input w-full" placeholder="หมายเหตุถึงร้าน (ถ้ามี)" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {err && <p className="text-sm text-rose-600">{err}</p>}
            <button type="button" disabled={busy || lines.length === 0} onClick={submit} className="w-full rounded-2xl bg-brand text-white font-bold py-3.5 disabled:opacity-40">{busy ? "กำลังส่ง…" : `สั่งซื้อ · ฿${fmtMoney(total)}`}</button>
            <p className="text-center text-[11px] text-slate-400">หลังสั่งแล้วจะได้เลขคิวและเลือกวิธีชำระเงินในหน้าถัดไป</p>
          </div>
        </div>
      )}
    </div>
  );
}

function OptionSheet({ item, onClose, onAdd }: { item: GuestMenuItem; onClose: () => void; onAdd: (ids: number[], qty: number) => void }) {
  // single-pick required groups start on their first available choice, like the KOI sheet (a default is always selected)
  const [ids, setIds] = useState<number[]>(() => item.options.filter((g) => g.minPick >= 1 && g.maxPick === 1).map((g) => g.choices.find((c) => c.available)?.id).filter((x): x is number => x != null));
  const [qty, setQty] = useState(1);
  const pick = (g: Group, c: Choice) => setIds((cur) => {
    const inGroup = g.choices.map((x) => x.id);
    if (cur.includes(c.id)) return g.minPick >= 1 && g.maxPick === 1 ? cur : cur.filter((x) => x !== c.id);
    if (g.maxPick === 1) return [...cur.filter((x) => !inGroup.includes(x)), c.id];
    return cur.filter((x) => inGroup.includes(x)).length >= g.maxPick ? cur : [...cur, c.id];
  });
  const missing = item.options.find((g) => ids.filter((i) => g.choices.some((c) => c.id === i)).length < g.minPick);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div><h2 className="text-lg font-bold text-slate-800">{item.name}</h2>{item.description && <p className="text-xs text-slate-500 mt-0.5">{item.description}</p>}</div>
            <button type="button" className="text-slate-400 text-2xl leading-none" onClick={onClose} aria-label="ปิด">×</button>
          </div>
          {item.options.map((g) => (
            <div key={g.id}>
              <div className="flex items-baseline gap-2 mb-1.5"><span className="font-semibold text-slate-700">{g.name}</span>
                <span className="text-[11px] text-slate-400">{g.minPick >= 1 ? "ต้องเลือก" : g.maxPick > 1 ? `เลือกได้สูงสุด ${g.maxPick}` : "ไม่บังคับ"}</span></div>
              <div className="flex flex-wrap gap-2">
                {g.choices.map((c) => {
                  const on = ids.includes(c.id);
                  return <button key={c.id} type="button" disabled={!c.available} onClick={() => pick(g, c)}
                    className={`rounded-full border px-3.5 py-1.5 text-sm ${on ? "bg-brand/10 border-brand text-brand font-semibold" : "border-slate-300 text-slate-700"} ${c.available ? "" : "opacity-40 line-through"}`}>
                    {c.name}{c.priceDelta ? ` ${c.priceDelta > 0 ? "+" : ""}${fmtMoney(c.priceDelta)}` : ""}</button>;
                })}
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-700">จำนวน</span>
            <div className="flex items-center gap-3"><button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} className="h-9 w-9 rounded-full border border-slate-300" aria-label="ลด">−</button><span className="w-6 text-center tabular-nums text-lg">{qty}</span><button type="button" onClick={() => setQty((q) => Math.min(50, q + 1))} className="h-9 w-9 rounded-full border border-brand text-brand" aria-label="เพิ่ม">+</button></div>
          </div>
          <button type="button" disabled={!!missing} onClick={() => onAdd(ids, qty)} className="w-full rounded-2xl bg-brand text-white font-bold py-3.5 disabled:opacity-40">
            {missing ? `กรุณาเลือก ${missing.name}` : `เพิ่มลงตะกร้า · ฿${fmtMoney(unitPrice(item, ids) * qty)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
