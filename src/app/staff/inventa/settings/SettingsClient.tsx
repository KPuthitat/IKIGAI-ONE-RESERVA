"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import type { LookupKind, InventaLookup, InventaSupplier } from "@/lib/inventa";

const KINDS: LookupKind[] = ["storage", "unit", "category"];

// kind → i18n key for its label (no more Thai-only LOOKUP_KIND_META).
const KIND_KEY: Record<LookupKind, string> = {
  storage: "inv.f.location",
  unit: "inv.f.unit",
  category: "inv.f.category",
  row: "inv.f.location"
};

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
  lookups, suppliers, branchName
}: {
  lookups: InventaLookup[];
  suppliers: InventaSupplier[];
  branchName: string;
}) {
  const router = useRouter();
  const { t } = useLang();
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
      <div className="card">
        <p className="text-sm text-slate-700"
          dangerouslySetInnerHTML={{
            __html: t("inv.set.forBranch", { name: `<b>${branchName}</b>` })
          }} />
        <p className="text-[11px] text-slate-500 mt-0.5">
          {t("inv.set.branchHint")}
        </p>
      </div>

      {KINDS.map((k, i) => {
        const items = lookups.filter((l) => l.kind === k);
        const label = t(KIND_KEY[k]);
        return (
          <Section key={k} title={label} count={items.length}
            defaultOpen={i === 0}>
            <LookupBody label={label} items={items} busy={busy}
              onAdd={(v) => addLookup(k, v)} onDelete={delLookup} />
          </Section>
        );
      })}
      <Section title={t("inv.f.supplier")} count={suppliers.length}>
        <SupplierBody suppliers={suppliers} onChanged={refresh} />
      </Section>

      <Section title={t("inv.reset.title")} count={0}>
        <ResetDataBody onChanged={refresh} />
      </Section>
    </div>
  );
}

function ResetDataBody({ onChanged }: { onChanged: () => void }) {
  const { t } = useLang();
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // The API requires this exact Thai token regardless of UI language.
  const CONFIRM = "ล้างข้อมูล";

  async function reset() {
    if (phrase.trim() !== CONFIRM) {
      setMsg(t("inv.reset.mismatch", { w: CONFIRM }));
      return;
    }
    if (!window.confirm(t("inv.reset.confirm2"))) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/inventa/admin/reset"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: CONFIRM })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setMsg(j.error ?? t("inv.reset.fail")); return; }
      const d = j.deleted;
      setMsg(t("inv.reset.doneMsg", {
        items: d.items, sup: d.suppliers, lk: d.lookups,
        cnt: d.counts, ord: d.orders
      }));
      setPhrase("");
      onChanged();
    } catch {
      setMsg(t("inv.reset.fail"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3 leading-relaxed">
        {t("inv.reset.warn")}
      </div>
      <div>
        <label className="label text-[11px]">
          {t("inv.reset.typeConfirm", { w: CONFIRM })}
        </label>
        <input className="input text-sm" value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder={CONFIRM} />
      </div>
      {msg && <div className="text-sm text-slate-700">{msg}</div>}
      <button type="button" onClick={reset}
        disabled={busy || phrase.trim() !== CONFIRM}
        className="text-sm px-4 py-2 rounded-lg bg-rose-600 text-white font-bold disabled:opacity-50">
        {busy ? t("inv.reset.btnBusy") : t("inv.reset.title")}
      </button>
    </div>
  );
}

function LookupBody({
  label, items, busy, onAdd, onDelete
}: {
  label: string;
  items: InventaLookup[];
  busy: boolean;
  onAdd: (v: string) => void;
  onDelete: (id: number) => void;
}) {
  const { t } = useLang();
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
          <span className="text-sm text-slate-400">{t("inv.lk.none")}</span>
        )}
      </div>
      <div className="flex gap-2">
        <input className="input flex-1" value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder={t("inv.lk.addPh", { label })}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); onAdd(v); setV(""); }
          }} />
        <button type="button" disabled={busy || !v.trim()}
          onClick={() => { onAdd(v); setV(""); }}
          className="text-sm px-4 py-2 rounded-lg bg-brand text-white font-bold disabled:opacity-50">
          {t("inv.btn.add")}
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
  const { t } = useLang();
  const [name, setName] = useState("");
  const [cycle, setCycle] = useState("");
  const [lead, setLead] = useState("");
  const [busy, setBusy] = useState(false);
  // 2026-05-27: inline-edit state. editingId points at the row in
  // edit mode (only one row editable at a time so the visual stays
  // simple); edit{Name,Cycle,Lead} hold the form values pre-saved
  // from that row. The PATCH endpoint at
  // /api/inventa/suppliers/[id] was already in place — only the UI
  // was missing.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editCycle, setEditCycle] = useState("");
  const [editLead, setEditLead] = useState("");

  function startEdit(s: InventaSupplier) {
    setEditingId(s.id);
    setEditName(s.name);
    setEditCycle(s.order_cycle ?? "");
    setEditLead(s.lead_time ?? "");
  }
  async function saveEdit() {
    if (editingId == null || !editName.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/suppliers/${editingId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          order_cycle: editCycle.trim() || null,
          lead_time: editLead.trim() || null
        })
      });
      if (res.ok) {
        setEditingId(null);
        onChanged();
      }
    } finally { setBusy(false); }
  }

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
    if (!confirm(t("inv.sup.delConfirm", { name: nm }))) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/suppliers/${id}`), { method: "DELETE" });
      if (res.ok) onChanged();
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="border border-slate-200 rounded-lg p-3 space-y-2">
        <input className="input" value={name} placeholder={t("inv.sup.namePh")}
          onChange={(e) => setName(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <input className="input text-sm" value={cycle}
            placeholder={t("inv.sup.cyclePh")}
            onChange={(e) => setCycle(e.target.value)} />
          <input className="input text-sm" value={lead}
            placeholder={t("inv.sup.leadPh")}
            onChange={(e) => setLead(e.target.value)} />
        </div>
        <button type="button" onClick={add} disabled={busy || !name.trim()}
          className="w-full py-2 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
          {t("inv.sup.add")}
        </button>
      </div>
      <div className="divide-y divide-slate-100">
        {suppliers.map((s) => {
          const isEditing = editingId === s.id;
          if (isEditing) {
            return (
              <div key={s.id} className="py-2 space-y-2 bg-amber-50 rounded -mx-1 px-1">
                <input className="input text-sm" value={editName}
                  placeholder={t("inv.sup.namePh")}
                  onChange={(e) => setEditName(e.target.value)} />
                <div className="grid grid-cols-2 gap-2">
                  <input className="input text-sm" value={editCycle}
                    placeholder={t("inv.sup.cyclePh")}
                    onChange={(e) => setEditCycle(e.target.value)} />
                  <input className="input text-sm" value={editLead}
                    placeholder={t("inv.sup.leadPh")}
                    onChange={(e) => setEditLead(e.target.value)} />
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setEditingId(null)}
                    disabled={busy}
                    className="flex-1 py-1.5 rounded-lg border border-slate-200 text-xs">
                    ยกเลิก
                  </button>
                  <button type="button" onClick={saveEdit}
                    disabled={busy || !editName.trim()}
                    className="flex-1 py-1.5 rounded-lg bg-brand text-white text-xs font-bold disabled:opacity-50">
                    บันทึก
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div key={s.id} className="py-2 flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-slate-800 text-sm">{s.name}</div>
                <div className="text-xs text-slate-500">
                  {s.order_cycle ? `${t("inv.sup.order")}: ${s.order_cycle}` : ""}
                  {s.lead_time ? ` · ${t("inv.sup.deliver")}: ${s.lead_time}` : ""}
                </div>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button type="button" onClick={() => startEdit(s)}
                  className="text-xs text-brand hover:underline">แก้ไข</button>
                <button type="button" onClick={() => del(s.id, s.name)}
                  className="text-xs text-rose-600 hover:underline">{t("inv.btn.delete")}</button>
              </div>
            </div>
          );
        })}
        {suppliers.length === 0 && (
          <div className="py-4 text-center text-slate-400 text-sm">
            {t("inv.sup.none")}
          </div>
        )}
      </div>
    </>
  );
}
