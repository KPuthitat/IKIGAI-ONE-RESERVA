"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import {
  LOOKUP_KIND_META, type LookupKind, type InventaLookup,
  type InventaSupplier
} from "@/lib/inventa";

const KINDS: LookupKind[] = ["row", "storage", "unit", "category"];

// Each setting group is a top-to-bottom collapsible section
// (accordion) so the page reads as a tidy list instead of a wall of
// chips. First section open by default; the rest collapsed.
function Section({
  title, count, defaultOpen, children
}: {
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="card !p-0 overflow-hidden group" open={defaultOpen}>
      <summary className="cursor-pointer list-none select-none flex items-center justify-between px-4 py-3 hover:bg-slate-50">
        <span className="font-bold text-slate-800">
          {title}
          <span className="ml-2 text-xs font-normal text-slate-400">({count})</span>
        </span>
        <span className="text-slate-400 transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="px-4 pb-4 pt-1 space-y-3 border-t border-slate-100">
        {children}
      </div>
    </details>
  );
}

export default function SettingsClient({
  lookups, suppliers
}: {
  lookups: InventaLookup[];
  suppliers: InventaSupplier[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());
  const [busy, setBusy] = useState(false);

  async function addLookup(kind: LookupKind, value: string) {
    if (!value.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/inventa/lookups"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, value: value.trim() })
      });
      if (res.ok) refresh();
    } finally { setBusy(false); }
  }
  async function delLookup(id: number) {
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/lookups/${id}`), { method: "DELETE" });
      if (res.ok) refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      {KINDS.map((k, i) => {
        const items = lookups.filter((l) => l.kind === k);
        return (
          <Section key={k} title={LOOKUP_KIND_META[k]} count={items.length}
            defaultOpen={i === 0}>
            <LookupBody kind={k} items={items} busy={busy}
              onAdd={(v) => addLookup(k, v)} onDelete={delLookup} />
          </Section>
        );
      })}
      <Section title="ผู้สั่ง / บริษัทผู้จำหน่าย" count={suppliers.length}>
        <SupplierBody suppliers={suppliers} onChanged={refresh} />
      </Section>
    </div>
  );
}

function LookupBody({
  kind, items, busy, onAdd, onDelete
}: {
  kind: LookupKind;
  items: InventaLookup[];
  busy: boolean;
  onAdd: (v: string) => void;
  onDelete: (id: number) => void;
}) {
  const [v, setV] = useState("");
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {items.map((it) => (
          <span key={it.id}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1 rounded-full bg-slate-100 text-slate-700">
            {it.value}
            <button type="button" disabled={busy}
              onClick={() => onDelete(it.id)}
              className="text-slate-400 hover:text-rose-600 font-bold leading-none">
              ×
            </button>
          </span>
        ))}
        {items.length === 0 && (
          <span className="text-sm text-slate-400">ยังไม่มีตัวเลือก</span>
        )}
      </div>
      <div className="flex gap-2">
        <input className="input flex-1" value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder={`เพิ่ม ${LOOKUP_KIND_META[kind]}`}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); onAdd(v); setV(""); }
          }} />
        <button type="button" disabled={busy || !v.trim()}
          onClick={() => { onAdd(v); setV(""); }}
          className="text-sm px-4 py-2 rounded-lg bg-brand text-white font-bold disabled:opacity-50">
          เพิ่ม
        </button>
      </div>
    </>
  );
}

function SupplierBody({
  suppliers, onChanged
}: {
  suppliers: InventaSupplier[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [cycle, setCycle] = useState("");
  const [lead, setLead] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/inventa/suppliers"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          order_cycle: cycle.trim() || null,
          lead_time: lead.trim() || null
        })
      });
      if (res.ok) { setName(""); setCycle(""); setLead(""); onChanged(); }
    } finally { setBusy(false); }
  }
  async function del(id: number, nm: string) {
    if (!confirm(`ลบผู้จำหน่าย "${nm}"?`)) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/suppliers/${id}`), { method: "DELETE" });
      if (res.ok) onChanged();
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="border border-slate-200 rounded-lg p-3 space-y-2">
        <input className="input" value={name} placeholder="ชื่อบริษัท *"
          onChange={(e) => setName(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <input className="input text-sm" value={cycle}
            placeholder="รอบสั่ง"
            onChange={(e) => setCycle(e.target.value)} />
          <input className="input text-sm" value={lead}
            placeholder="รอบส่ง"
            onChange={(e) => setLead(e.target.value)} />
        </div>
        <button type="button" onClick={add} disabled={busy || !name.trim()}
          className="w-full py-2 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
          + เพิ่มบริษัท
        </button>
      </div>
      <div className="divide-y divide-slate-100">
        {suppliers.map((s) => (
          <div key={s.id} className="py-2 flex items-start justify-between gap-2">
            <div>
              <div className="font-medium text-slate-800 text-sm">{s.name}</div>
              <div className="text-xs text-slate-500">
                {s.order_cycle ? `สั่ง: ${s.order_cycle}` : ""}
                {s.lead_time ? ` · ส่ง: ${s.lead_time}` : ""}
              </div>
            </div>
            <button type="button" onClick={() => del(s.id, s.name)}
              className="text-xs text-rose-600 hover:underline">ลบ</button>
          </div>
        ))}
        {suppliers.length === 0 && (
          <div className="py-4 text-center text-slate-400 text-sm">ยังไม่มีบริษัท</div>
        )}
      </div>
    </>
  );
}
