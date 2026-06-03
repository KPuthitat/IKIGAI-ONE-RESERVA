"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import type { LookupKind, InventaLookup, InventaSupplier } from "@/lib/inventa";

const KINDS: LookupKind[] = ["item_type", "category", "storage", "unit"];

// kind → i18n key for its label (no more Thai-only LOOKUP_KIND_META).
const KIND_KEY: Record<LookupKind, string> = {
  storage: "inv.f.location",
  unit: "inv.f.unit",
  category: "inv.f.category",
  item_type: "inv.f.itemType",
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

  async function addLookup(kind: LookupKind, value: string, code: string) {
    if (!value.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/inventa/lookups"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind, value: value.trim(),
          code: code.trim() || null
        })
      });
      if (res.ok) refresh();
    } finally { setBusy(false); }
  }
  async function patchLookup(id: number, patch: { value?: string; code?: string | null }) {
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/lookups/${id}`), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (res.ok) refresh();
    } finally { setBusy(false); }
  }
  async function reorderLookup(id: number, direction: "up" | "down") {
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/lookups/${id}/reorder`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction })
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
              onAdd={(v, code) => addLookup(k, v, code)}
              onPatch={patchLookup}
              onReorder={reorderLookup}
              onDelete={delLookup} />
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
  label, items, busy, onAdd, onPatch, onReorder, onDelete
}: {
  label: string;
  items: InventaLookup[];
  busy: boolean;
  onAdd: (value: string, code: string) => void;
  onPatch: (id: number, patch: { value?: string; code?: string | null }) => void;
  onReorder: (id: number, direction: "up" | "down") => void;
  onDelete: (id: number) => void;
}) {
  const { t } = useLang();
  // Add-row state. `code` is optional — admins can skip it and
  // fill in later via the inline edit on each row.
  const [v, setV] = useState("");
  const [code, setCode] = useState("");
  // Inline-edit state: only one row at a time to keep the visual
  // simple and avoid stale-value pitfalls.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editCode, setEditCode] = useState("");

  function startEdit(it: InventaLookup) {
    setEditingId(it.id);
    setEditValue(it.value);
    setEditCode(it.code ?? "");
  }
  function saveEdit() {
    if (editingId == null || !editValue.trim()) return;
    onPatch(editingId, {
      value: editValue.trim(),
      code: editCode.trim() || null
    });
    setEditingId(null);
  }

  return (
    <>
      <div className="rounded-lg border border-slate-200 divide-y divide-slate-100 bg-white">
        {items.map((it, idx) => {
          const isFirst = idx === 0;
          const isLast = idx === items.length - 1;
          const isEditing = editingId === it.id;
          if (isEditing) {
            return (
              <div key={it.id} className="p-2 bg-amber-50 space-y-2">
                <div className="grid grid-cols-[80px_1fr] gap-2">
                  <input className="input text-sm uppercase tracking-wide font-bold"
                    value={editCode}
                    maxLength={12}
                    placeholder={t("inv.lk.codePh")}
                    onChange={(e) => setEditCode(e.target.value)} />
                  <input className="input text-sm" value={editValue}
                    placeholder={t("inv.lk.namePh", { label })}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); saveEdit(); }
                      if (e.key === "Escape") { setEditingId(null); }
                    }} />
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setEditingId(null)}
                    disabled={busy}
                    className="flex-1 py-1.5 rounded-lg border border-slate-200 text-xs">
                    {t("common.cancel")}
                  </button>
                  <button type="button" onClick={saveEdit}
                    disabled={busy || !editValue.trim()}
                    className="flex-1 py-1.5 rounded-lg bg-brand text-white text-xs font-bold disabled:opacity-50">
                    {t("common.save")}
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div key={it.id} className="px-2 py-2 flex items-center gap-2">
              {/* Reorder column (▲▼). Edges grey out when at the
                  boundary so admins get an obvious cue. */}
              <div className="flex flex-col gap-0.5 flex-shrink-0">
                <button type="button" disabled={busy || isFirst}
                  onClick={() => onReorder(it.id, "up")}
                  aria-label={t("inv.lk.moveUp")}
                  className="w-6 h-5 rounded text-[10px] text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed">
                  ▲
                </button>
                <button type="button" disabled={busy || isLast}
                  onClick={() => onReorder(it.id, "down")}
                  aria-label={t("inv.lk.moveDown")}
                  className="w-6 h-5 rounded text-[10px] text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed">
                  ▼
                </button>
              </div>
              {/* Code chip — bold + uppercase for at-a-glance scanning;
                  italic placeholder when missing so the admin knows
                  there's an empty slot to fill. */}
              <div className={
                "w-16 text-center text-xs font-bold uppercase tracking-wide flex-shrink-0 px-1 py-1 rounded "
                + (it.code
                  ? "bg-slate-100 text-slate-700"
                  : "text-slate-300 italic")
              }>
                {it.code ?? "—"}
              </div>
              <div className="flex-1 min-w-0 text-sm text-slate-800 truncate">
                {it.value}
              </div>
              <div className="flex gap-2 flex-shrink-0 text-xs">
                <button type="button" disabled={busy}
                  onClick={() => startEdit(it)}
                  className="text-brand hover:underline">
                  {t("common.edit")}
                </button>
                <button type="button" disabled={busy}
                  onClick={() => onDelete(it.id)}
                  className="text-rose-600 hover:underline">
                  {t("inv.btn.delete")}
                </button>
              </div>
            </div>
          );
        })}
        {items.length === 0 && (
          <div className="px-3 py-4 text-sm text-slate-400 text-center">
            {t("inv.lk.none")}
          </div>
        )}
      </div>
      {/* Add row. Code first so the eye lands on it the same way as
          the existing rows above. */}
      <div className="grid grid-cols-[80px_1fr_auto] gap-2">
        <input className="input uppercase tracking-wide font-bold"
          value={code}
          maxLength={12}
          placeholder={t("inv.lk.codePh")}
          onChange={(e) => setCode(e.target.value)} />
        <input className="input" value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder={t("inv.lk.addPh", { label })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd(v, code);
              setV(""); setCode("");
            }
          }} />
        <button type="button" disabled={busy || !v.trim()}
          onClick={() => { onAdd(v, code); setV(""); setCode(""); }}
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
  const [code, setCode] = useState("");
  const [cycle, setCycle] = useState("");
  const [lead, setLead] = useState("");
  const [busy, setBusy] = useState(false);
  // 2026-05-31: code + display_order added. Inline edit gains a
  // dedicated `editCode` field (same one-row-at-a-time pattern).
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editCode, setEditCode] = useState("");
  const [editCycle, setEditCycle] = useState("");
  const [editLead, setEditLead] = useState("");

  function startEdit(s: InventaSupplier) {
    setEditingId(s.id);
    setEditName(s.name);
    setEditCode(s.code ?? "");
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
          code: editCode.trim() || null,
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
  async function reorder(id: number, direction: "up" | "down") {
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/suppliers/${id}/reorder`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction })
      });
      if (res.ok) onChanged();
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
          code: code.trim() || null,
          order_cycle: cycle.trim() || null,
          lead_time: lead.trim() || null
        })
      });
      if (res.ok) {
        setName(""); setCode(""); setCycle(""); setLead("");
        onChanged();
      }
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
        <div className="grid grid-cols-[100px_1fr] gap-2">
          <input className="input uppercase tracking-wide font-bold"
            value={code} maxLength={12}
            placeholder={t("inv.sup.codePh")}
            onChange={(e) => setCode(e.target.value)} />
          <input className="input" value={name}
            placeholder={t("inv.sup.namePh")}
            onChange={(e) => setName(e.target.value)} />
        </div>
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
        {suppliers.map((s, idx) => {
          const isFirst = idx === 0;
          const isLast = idx === suppliers.length - 1;
          const isEditing = editingId === s.id;
          if (isEditing) {
            return (
              <div key={s.id} className="py-2 space-y-2 bg-amber-50 rounded -mx-1 px-1">
                <div className="grid grid-cols-[100px_1fr] gap-2">
                  <input className="input text-sm uppercase tracking-wide font-bold"
                    value={editCode} maxLength={12}
                    placeholder={t("inv.sup.codePh")}
                    onChange={(e) => setEditCode(e.target.value)} />
                  <input className="input text-sm" value={editName}
                    placeholder={t("inv.sup.namePh")}
                    onChange={(e) => setEditName(e.target.value)} />
                </div>
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
                    {t("common.cancel")}
                  </button>
                  <button type="button" onClick={saveEdit}
                    disabled={busy || !editName.trim()}
                    className="flex-1 py-1.5 rounded-lg bg-brand text-white text-xs font-bold disabled:opacity-50">
                    {t("common.save")}
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div key={s.id} className="py-2 flex items-center gap-2">
              <div className="flex flex-col gap-0.5 flex-shrink-0">
                <button type="button" disabled={busy || isFirst}
                  onClick={() => reorder(s.id, "up")}
                  aria-label={t("inv.lk.moveUp")}
                  className="w-6 h-5 rounded text-[10px] text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed">
                  ▲
                </button>
                <button type="button" disabled={busy || isLast}
                  onClick={() => reorder(s.id, "down")}
                  aria-label={t("inv.lk.moveDown")}
                  className="w-6 h-5 rounded text-[10px] text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed">
                  ▼
                </button>
              </div>
              <div className={
                "w-16 text-center text-xs font-bold uppercase tracking-wide flex-shrink-0 px-1 py-1 rounded "
                + (s.code
                  ? "bg-slate-100 text-slate-700"
                  : "text-slate-300 italic")
              }>
                {s.code ?? "—"}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-slate-800 text-sm truncate">{s.name}</div>
                <div className="text-xs text-slate-500 truncate">
                  {s.order_cycle ? `${t("inv.sup.order")}: ${s.order_cycle}` : ""}
                  {s.lead_time ? ` · ${t("inv.sup.deliver")}: ${s.lead_time}` : ""}
                </div>
              </div>
              <div className="flex gap-2 flex-shrink-0 text-xs">
                <button type="button" onClick={() => startEdit(s)}
                  className="text-brand hover:underline">
                  {t("common.edit")}
                </button>
                <button type="button" onClick={() => del(s.id, s.name)}
                  className="text-rose-600 hover:underline">
                  {t("inv.btn.delete")}
                </button>
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
