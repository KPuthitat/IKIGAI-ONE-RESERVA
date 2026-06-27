"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { useConfirm } from "@/app/components/useConfirm";
import type { ShiftCode } from "@/lib/db";

// Inline editor for the branch's shift codes. Each row is editable
// in place — admin clicks "edit" to swap the cells into inputs, saves
// via PATCH. Color picker uses native input[type=color] so it works
// without any extra UI library on mobile too.

const DEFAULT_COLOR = "#cbd5e1";

export default function ShiftCodesClient({ codes }: { codes: ShiftCode[] }) {
  const router = useRouter();
  const { t } = useLang();
  const { confirm, ConfirmDialog } = useConfirm();
  const [pending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function save(body: Record<string, unknown>, method: "POST" | "PATCH") {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/roster/shift-code"), {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(j.error === "code_duplicate"
          ? t("admin.persona.roster.shifts.errCodeDuplicate")
          : (j.error ?? t("common.error")));
        return false;
      }
      return true;
    } catch {
      setErr(t("common.error"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    const ok = await confirm({ title: "ยืนยันการลบ", body: t("admin.persona.roster.shifts.confirmDelete"), confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger" });
    if (ok === null) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/roster/shift-code?id=${id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? t("common.error")); return; }
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      {ConfirmDialog}
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-slate-800 text-sm">
          {t("admin.persona.roster.shifts.listTitle")} ({codes.length})
        </h2>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="text-xs px-3 py-1.5 rounded border border-brand text-brand hover:bg-rose-50 font-bold"
          >
            + {t("admin.persona.roster.shifts.add")}
          </button>
        )}
      </div>

      {err && <div className="text-xs text-rose-600">✗ {err}</div>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-[0.5px] text-slate-500 border-b border-slate-200">
              <th className="py-2 pr-2 w-10"></th>
              <th className="py-2 pr-2">{t("admin.persona.roster.shifts.col.code")}</th>
              <th className="py-2 pr-2">{t("admin.persona.roster.shifts.col.name")}</th>
              <th className="py-2 pr-2">{t("admin.persona.roster.shifts.col.start")}</th>
              <th className="py-2 pr-2">{t("admin.persona.roster.shifts.col.end")}</th>
              <th className="py-2 pr-2">{t("admin.persona.roster.shifts.col.break")}</th>
              <th className="py-2 pr-2 w-24"></th>
            </tr>
          </thead>
          <tbody>
            {creating && (
              <ShiftRow
                key="new"
                code={null}
                onCancel={() => setCreating(false)}
                onSave={async (body) => {
                  if (await save(body, "POST")) {
                    setCreating(false);
                    refresh();
                  }
                }}
                busy={busy}
                t={t}
              />
            )}
            {codes.map((c) => (
              <ShiftRow
                key={c.id}
                code={c}
                editing={editingId === c.id}
                onStartEdit={() => setEditingId(c.id)}
                onCancel={() => setEditingId(null)}
                onDelete={() => remove(c.id)}
                onSave={async (body) => {
                  if (await save({ id: c.id, ...body }, "PATCH")) {
                    setEditingId(null);
                    refresh();
                  }
                }}
                busy={busy}
                t={t}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ShiftRow({
  code, editing, onStartEdit, onCancel, onDelete, onSave, busy, t
}: {
  code: ShiftCode | null;
  editing?: boolean;
  onStartEdit?: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  onSave: (body: Record<string, unknown>) => void;
  busy: boolean;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  const isNew = code === null;
  const isEditing = isNew || editing;
  const [codeVal, setCodeVal] = useState(code?.code ?? "");
  const [name, setName] = useState(code?.name ?? "");
  const [start, setStart] = useState(code?.start_time ?? "11:00");
  const [end, setEnd] = useState(code?.end_time ?? "21:00");
  const [bs, setBs] = useState(code?.break_start ?? "");
  const [be, setBe] = useState(code?.break_end ?? "");
  const [color, setColor] = useState(code?.color ?? "#fecdd3");

  if (!isEditing && code) {
    return (
      <tr className="border-b border-slate-100 last:border-b-0">
        <td className="py-2 pr-2">
          <div
            className="w-6 h-6 rounded border border-slate-300"
            style={{ backgroundColor: code.color ?? DEFAULT_COLOR }}
          />
        </td>
        <td className="py-2 pr-2 font-bold text-slate-800">{code.code}</td>
        <td className="py-2 pr-2 text-slate-600">{code.name ?? "—"}</td>
        <td className="py-2 pr-2 font-mono text-xs">{code.start_time}</td>
        <td className="py-2 pr-2 font-mono text-xs">{code.end_time}</td>
        <td className="py-2 pr-2 font-mono text-xs text-slate-500">
          {code.break_start && code.break_end
            ? `${code.break_start}–${code.break_end}`
            : t("admin.persona.roster.shifts.noBreak")}
        </td>
        <td className="py-2 pr-2 text-right whitespace-nowrap">
          <button type="button" onClick={onStartEdit}
            className="text-xs text-brand hover:underline mr-2">
            {t("admin.persona.roster.shifts.edit")}
          </button>
          <button type="button" onClick={onDelete}
            className="text-xs text-rose-500 hover:underline">
            {t("admin.persona.roster.shifts.delete")}
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-slate-100 last:border-b-0 bg-slate-50/50">
      <td className="py-2 pr-2">
        <input
          type="color"
          className="w-8 h-8 border border-slate-300 rounded cursor-pointer"
          value={color}
          onChange={(e) => setColor(e.target.value)}
        />
      </td>
      <td className="py-2 pr-2">
        <input className="input text-sm" placeholder="NPF"
          value={codeVal} onChange={(e) => setCodeVal(e.target.value)} maxLength={40} />
      </td>
      <td className="py-2 pr-2">
        <input className="input text-sm" placeholder={t("admin.persona.roster.shifts.namePlaceholder")}
          value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </td>
      <td className="py-2 pr-2">
        <input type="time" className="input text-sm"
          value={start} onChange={(e) => setStart(e.target.value)} />
      </td>
      <td className="py-2 pr-2">
        <input type="time" className="input text-sm"
          value={end} onChange={(e) => setEnd(e.target.value)} />
      </td>
      <td className="py-2 pr-2">
        <div className="flex gap-1 items-center">
          <input type="time" className="input text-xs w-24"
            value={bs} onChange={(e) => setBs(e.target.value)} />
          <span>–</span>
          <input type="time" className="input text-xs w-24"
            value={be} onChange={(e) => setBe(e.target.value)} />
        </div>
      </td>
      <td className="py-2 pr-2 text-right whitespace-nowrap">
        <button type="button" disabled={busy}
          onClick={() => onSave({
            code: codeVal,
            name: name || null,
            start_time: start,
            end_time: end,
            break_start: bs || null,
            break_end: be || null,
            color
          })}
          className="text-xs px-2 py-0.5 rounded bg-brand text-white font-bold mr-1 disabled:opacity-50">
          {busy ? "…" : t("common.save")}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}
          className="text-xs px-2 py-0.5 rounded border border-slate-300 text-slate-600">
          {t("common.cancel")}
        </button>
      </td>
    </tr>
  );
}
