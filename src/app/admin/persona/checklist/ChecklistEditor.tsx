"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import type { ShiftChecklistItem } from "@/lib/db";
import { parseChecklistOptions } from "@/lib/checklist-options";

// Editor for a per-branch checklist. The same UI handles all 4
// daily-report types: shift_open, shift_close, readiness_1130,
// readiness_1600. The page passes the active `type` so new items
// land in the correct list.
//
// Inline edit + reorder via up/down buttons + soft (active 0/1) and
// hard (DELETE) removals. Each row mutates immediately to the API so
// admin doesn't have to remember to "save".

type ChecklistType = "shift_open" | "shift_close" | "readiness_1130" | "readiness_1600";

export default function ChecklistEditor({
  initialItems, branchId, type
}: {
  initialItems: ShiftChecklistItem[];
  /** Branch the editor is currently scoped to. Sent on POST so new
   *  items are created inside this branch's list. PATCH/DELETE don't
   *  need it because the API guards by item id → item.branch_id. */
  branchId: number;
  /** Which checklist type this editor is editing — sent on POST so
   *  new items land in the right list. */
  type: ChecklistType;
}) {
  const router = useRouter();
  const { t } = useLang();
  const [items, setItems] = useState<ShiftChecklistItem[]>(initialItems);
  // Re-sync from props whenever the server data changes — happens after
  // every router.refresh() that follows an add/PATCH/delete. Without
  // this, useState's lazy initializer holds the old list forever and
  // newly-added rows appear only after a hard browser reload. The
  // optimistic-delete code in deleteItem() still works because the
  // server's next refresh also won't include the deleted row, so the
  // sync re-applies the same end state.
  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newKind, setNewKind] = useState<"checkbox" | "text" | "choice" | "amount" | "section">("checkbox");
  // Buffered options for the "add new item" form. Only meaningful when
  // newKind === 'choice'. Min 2 entries enforced by the API and the
  // disabled-when-< 2 state on the Submit button.
  const [newOptions, setNewOptions] = useState<string[]>(["", ""]);
  const [busyAdd, setBusyAdd] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);

  async function patchItem(
    id: number,
    patch: Partial<ShiftChecklistItem> & { options?: string[] }
  ) {
    setBusyId(id);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/checklist/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (!res.ok) throw new Error("patch failed");
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function deleteItem(id: number) {
    if (!confirm(t("admin.persona.checklist.confirmDelete"))) return;
    setBusyId(id);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/checklist/${id}`), {
        method: "DELETE"
      });
      if (!res.ok) throw new Error("delete failed");
      setItems((prev) => prev.filter((it) => it.id !== id));
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    setAddErr(null);
    const trimmed = newLabel.trim();
    if (!trimmed) return;

    // Choice items need ≥ 2 non-empty option strings. Filter blanks
    // before sending so admin can leave trailing empties without
    // tripping the API's min-length check.
    let payloadOptions: string[] | undefined;
    if (newKind === "choice") {
      payloadOptions = newOptions.map((o) => o.trim()).filter((o) => o.length > 0);
      if (payloadOptions.length < 2) {
        setAddErr(t("admin.persona.checklist.kind.choiceMinOptions"));
        return;
      }
    }

    setBusyAdd(true);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/checklist"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          label: trimmed,
          branch_id: branchId,
          kind: newKind,
          ...(payloadOptions ? { options: payloadOptions } : {})
        })
      });
      if (!res.ok) throw new Error("add failed");
      setNewLabel("");
      setNewKind("checkbox");
      setNewOptions(["", ""]);
      router.refresh();
    } finally {
      setBusyAdd(false);
    }
  }

  async function move(id: number, direction: -1 | 1) {
    // Swap display_order with the SIBLING neighbour at the same level
    // (same parent_id). Children only swap among children of the same
    // parent; top-level rows only swap with other top-level rows.
    const me = items.find((x) => x.id === id);
    if (!me) return;
    const siblings = items
      .filter((x) => (x.parent_id ?? null) === (me.parent_id ?? null))
      .sort((a, b) => a.display_order - b.display_order);
    const idx = siblings.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const target = idx + direction;
    if (target < 0 || target >= siblings.length) return;
    const a = siblings[idx];
    const b = siblings[target];
    setBusyId(id);
    try {
      await Promise.all([
        fetch(apiUrl(`/api/admin/persona/checklist/${a.id}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ display_order: b.display_order })
        }),
        fetch(apiUrl(`/api/admin/persona/checklist/${b.id}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ display_order: a.display_order })
        })
      ]);
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  // Group items into parent → children. Server query already orders by
  // display_order so the natural array order is correct for both
  // levels; we just split into top-level + children-by-parent maps.
  const topLevel = items
    .filter((it) => it.parent_id == null)
    .sort((a, b) => a.display_order - b.display_order);
  const childrenByParent = new Map<number, ShiftChecklistItem[]>();
  for (const it of items) {
    if (it.parent_id != null) {
      if (!childrenByParent.has(it.parent_id)) childrenByParent.set(it.parent_id, []);
      childrenByParent.get(it.parent_id)!.push(it);
    }
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => a.display_order - b.display_order);
  }

  // Inline "+ เพิ่มรายการย่อย" state — which parent currently has its
  // child-add form expanded, and its draft contents. Only one parent's
  // form is open at a time to keep the UI calm.
  const [childAddParentId, setChildAddParentId] = useState<number | null>(null);
  const [childAddLabel, setChildAddLabel] = useState("");
  const [childAddKind, setChildAddKind] = useState<"checkbox" | "text" | "choice" | "amount" | "section">("text");
  const [childAddOptions, setChildAddOptions] = useState<string[]>(["", ""]);
  const [childAddBusy, setChildAddBusy] = useState(false);
  const [childAddErr, setChildAddErr] = useState<string | null>(null);

  function openChildAdd(parentId: number) {
    setChildAddParentId(parentId);
    setChildAddLabel("");
    setChildAddKind("text");   // text is the common case ("Cash xx,xxx.xx")
    setChildAddOptions(["", ""]);
    setChildAddErr(null);
  }

  async function submitChildAdd() {
    if (childAddParentId == null) return;
    setChildAddErr(null);
    const trimmed = childAddLabel.trim();
    if (!trimmed) return;
    let payloadOptions: string[] | undefined;
    if (childAddKind === "choice") {
      payloadOptions = childAddOptions.map((o) => o.trim()).filter((o) => o.length > 0);
      if (payloadOptions.length < 2) {
        setChildAddErr(t("admin.persona.checklist.kind.choiceMinOptions"));
        return;
      }
    }
    setChildAddBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/checklist"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          label: trimmed,
          branch_id: branchId,
          kind: childAddKind,
          parent_id: childAddParentId,
          ...(payloadOptions ? { options: payloadOptions } : {})
        })
      });
      if (!res.ok) throw new Error("add child failed");
      setChildAddParentId(null);
      setChildAddLabel("");
      setChildAddKind("text");
      setChildAddOptions(["", ""]);
      router.refresh();
    } finally {
      setChildAddBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">
          {t("admin.persona.checklist.listTitle")}
        </h2>
        {topLevel.length === 0 ? (
          <div className="text-sm text-slate-500 text-center py-6">
            {t("admin.persona.checklist.empty")}
          </div>
        ) : (
          <div className="space-y-2">
            {topLevel.map((parent, i) => {
              const children = childrenByParent.get(parent.id) ?? [];
              return (
                <div key={parent.id} className="space-y-2">
                  <ChecklistRow
                    item={parent}
                    isFirst={i === 0}
                    isLast={i === topLevel.length - 1}
                    busy={busyId === parent.id}
                    onPatchLabel={(label) => patchItem(parent.id, { label })}
                    onPatchKind={(kind) => patchItem(parent.id, { kind })}
                    onPatchOptions={(opts) => patchItem(parent.id, { options: opts })}
                    onPatchHeadline={(flag) => patchItem(parent.id, { is_headline_amount: flag })}
                    onPatchDescription={(text) => patchItem(parent.id, { description: text })}
                    onToggleActive={() =>
                      patchItem(parent.id, { active: parent.active ? 0 : 1 })}
                    onMoveUp={() => move(parent.id, -1)}
                    onMoveDown={() => move(parent.id, 1)}
                    onDelete={() => deleteItem(parent.id)}
                    onAddChild={() => openChildAdd(parent.id)}
                    t={t}
                  />
                  {/* Children — indented and visually grouped under the
                      parent. Move up/down stays scoped to siblings. */}
                  {children.length > 0 && (
                    <div className="ml-8 space-y-2 border-l-2 border-slate-200 pl-3">
                      {children.map((child, ci) => (
                        <ChecklistRow
                          key={child.id}
                          item={child}
                          isFirst={ci === 0}
                          isLast={ci === children.length - 1}
                          busy={busyId === child.id}
                          isChild
                          onPatchLabel={(label) => patchItem(child.id, { label })}
                          onPatchKind={(kind) => patchItem(child.id, { kind })}
                          onPatchOptions={(opts) => patchItem(child.id, { options: opts })}
                          onPatchHeadline={(flag) => patchItem(child.id, { is_headline_amount: flag })}
                          onPatchDescription={(text) => patchItem(child.id, { description: text })}
                          onToggleActive={() =>
                            patchItem(child.id, { active: child.active ? 0 : 1 })}
                          onMoveUp={() => move(child.id, -1)}
                          onMoveDown={() => move(child.id, 1)}
                          onDelete={() => deleteItem(child.id)}
                          t={t}
                        />
                      ))}
                    </div>
                  )}
                  {/* Inline child-add form — collapsed by default,
                      expands when admin clicks "+ เพิ่มรายการย่อย"
                      on the parent row. Only one parent shows the
                      form at a time. */}
                  {childAddParentId === parent.id && (
                    <div className="ml-8 border-l-2 border-brand pl-3 py-2 space-y-2">
                      {/* Same mobile-stack pattern as the parent add
                          form — input + kind + buttons stack vertically
                          on phones so the input has full width. */}
                      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
                        <input
                          type="text"
                          className="input w-full sm:flex-1 text-sm"
                          value={childAddLabel}
                          autoFocus
                          maxLength={200}
                          onChange={(e) => setChildAddLabel(e.target.value)}
                          placeholder={t("admin.persona.checklist.childAddPlaceholder")}
                        />
                        <select
                          className="input text-sm w-full sm:w-auto"
                          value={childAddKind}
                          onChange={(e) => setChildAddKind(e.target.value as "checkbox" | "text" | "choice" | "amount" | "section")}
                        >
                          <option value="text">{t("admin.persona.checklist.kind.text")}</option>
                          <option value="checkbox">{t("admin.persona.checklist.kind.checkbox")}</option>
                          <option value="amount">{t("admin.persona.checklist.kind.amount")}</option>
                          <option value="choice">{t("admin.persona.checklist.kind.choice")}</option>
                          <option value="section">{t("admin.persona.checklist.kind.section")}</option>
                        </select>
                        <div className="flex gap-2 w-full sm:w-auto">
                          <button
                            type="button"
                            disabled={childAddBusy || !childAddLabel.trim()}
                            onClick={submitChildAdd}
                            className="btn-primary text-sm whitespace-nowrap flex-1 sm:flex-initial"
                          >
                            {childAddBusy ? t("common.submitting") : t("admin.persona.checklist.childAddBtn")}
                          </button>
                          <button
                            type="button"
                            onClick={() => setChildAddParentId(null)}
                            disabled={childAddBusy}
                            className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50"
                          >
                            {t("common.cancel")}
                          </button>
                        </div>
                      </div>
                      {childAddKind === "choice" && (
                        <OptionsEditor
                          options={childAddOptions}
                          onChange={setChildAddOptions}
                          label={t("admin.persona.checklist.kind.optionsLabel")}
                          t={t}
                        />
                      )}
                      {childAddErr && (
                        <div className="text-xs text-rose-600">✗ {childAddErr}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <form onSubmit={addItem} className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">
          {t("admin.persona.checklist.addTitle")}
        </h2>
        {/* Mobile: stack vertically (input → kind → submit). Desktop
            (sm+): one flex row to keep the existing density. Without
            this stack the label input dropped under the kind dropdown
            on phones and admin couldn't see the text they were
            typing without scrolling. */}
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            className="input w-full sm:flex-1"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder={t("admin.persona.checklist.addPlaceholder")}
            maxLength={200}
          />
          <select
            className="input text-sm w-full sm:w-auto"
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as "checkbox" | "text" | "choice" | "amount" | "section")}
          >
            <option value="checkbox">{t("admin.persona.checklist.kind.checkbox")}</option>
            <option value="text">{t("admin.persona.checklist.kind.text")}</option>
            <option value="amount">{t("admin.persona.checklist.kind.amount")}</option>
            <option value="choice">{t("admin.persona.checklist.kind.choice")}</option>
            <option value="section">{t("admin.persona.checklist.kind.section")}</option>
          </select>
          <button
            type="submit"
            disabled={busyAdd || !newLabel.trim()}
            className="btn-primary text-sm whitespace-nowrap w-full sm:w-auto"
          >
            {busyAdd
              ? t("common.submitting")
              : t("admin.persona.checklist.addBtn")}
          </button>
        </div>
        <p className="text-[11px] text-slate-500">
          {t("admin.persona.checklist.kind.hint")}
        </p>
        {newKind === "choice" && (
          <OptionsEditor
            options={newOptions}
            onChange={setNewOptions}
            label={t("admin.persona.checklist.kind.optionsLabel")}
            t={t}
          />
        )}
        {addErr && <div className="text-xs text-rose-600">✗ {addErr}</div>}
      </form>
    </div>
  );
}

function ChecklistRow({
  item, isFirst, isLast, busy, isChild,
  onPatchLabel, onPatchKind, onPatchOptions, onPatchHeadline,
  onPatchDescription,
  onToggleActive, onMoveUp, onMoveDown, onDelete, onAddChild, t
}: {
  item: ShiftChecklistItem;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  /** True when the row is a child (already nested under a parent).
   *  Child rows don't get the "+ เพิ่มรายการย่อย" button — we keep
   *  nesting to 2 levels max. */
  isChild?: boolean;
  onPatchLabel: (label: string) => Promise<void>;
  onPatchKind: (kind: "checkbox" | "text" | "choice" | "amount" | "section") => Promise<void>;
  onPatchOptions: (options: string[]) => Promise<void>;
  /** amount kind only — toggle the "show big on LINE card" flag.
   *  Multiple amount rows can carry this; they stack by display_order
   *  with the first one rendered biggest. */
  onPatchHeadline: (flag: 0 | 1) => Promise<void>;
  /** Patch the description (small help text under the label).
   *  Triggered on blur of the inline editor. */
  onPatchDescription: (text: string) => Promise<void>;
  onToggleActive: () => Promise<void>;
  onMoveUp: () => Promise<void>;
  onMoveDown: () => Promise<void>;
  onDelete: () => Promise<void>;
  /** Top-level rows only — invoked when admin clicks
   *  "+ เพิ่มรายการย่อย". Parent component owns the inline form. */
  onAddChild?: () => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.label);
  // Local copy of the options array so the editor reflects keystrokes
  // immediately; we PATCH on blur of each input.
  const initialOptions = parseChecklistOptions(item);
  const [optionsDraft, setOptionsDraft] = useState<string[]>(
    initialOptions.length > 0 ? initialOptions : ["", ""]
  );

  async function save() {
    if (draft.trim() && draft !== item.label) {
      await onPatchLabel(draft.trim());
    }
    setEditing(false);
  }

  async function commitOptions(next: string[]) {
    setOptionsDraft(next);
    const cleaned = next.map((o) => o.trim()).filter((o) => o.length > 0);
    if (cleaned.length >= 2) {
      await onPatchOptions(cleaned);
    }
  }

  return (
    <div className={`p-2.5 rounded-lg border ${
      item.active ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-70"
    }`}>
      {/* Mobile: label fills the row; arrows/kind/active/delete drop
          onto a second flex-wrap row underneath so the label has room
          to breathe and doesn't truncate to one or two characters on
          phones. Desktop (sm+) keeps the original single-row density. */}
      <div className="flex items-start gap-2 sm:items-center sm:flex-nowrap flex-wrap">
        <div className="flex flex-col">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={busy || isFirst}
            className="text-xs px-2 py-0.5 text-slate-500 hover:text-brand disabled:opacity-30"
            aria-label="Move up"
          >▲</button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={busy || isLast}
            className="text-xs px-2 py-0.5 text-slate-500 hover:text-brand disabled:opacity-30"
            aria-label="Move down"
          >▼</button>
        </div>

        {editing ? (
          <input
            className="input flex-1 min-w-0 text-sm w-full"
            value={draft}
            autoFocus
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); save(); }
              if (e.key === "Escape") { setDraft(item.label); setEditing(false); }
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-1 min-w-0 basis-full sm:basis-auto text-left text-sm text-slate-800 hover:text-brand break-words"
          >
            {item.label}
            {!item.active && (
              <span className="ml-2 text-[10px] text-slate-400 font-medium">
                · {t("admin.persona.checklist.inactive")}
              </span>
            )}
          </button>
        )}

        {/* Controls cluster — wraps onto its own row on mobile via
            basis-full + sm:basis-auto. Each control stays compact;
            we let them spill horizontally inside this cluster
            without affecting the label above. */}
        <div className="flex items-center gap-2 basis-full sm:basis-auto flex-wrap ml-7 sm:ml-0">
          <select
            value={item.kind ?? "checkbox"}
            disabled={busy}
            onChange={(e) => onPatchKind(e.target.value as "checkbox" | "text" | "choice" | "amount" | "section")}
            className="text-xs border border-slate-300 rounded px-1.5 py-1 text-slate-700 bg-white"
            title={t("admin.persona.checklist.kind.hint")}
          >
            <option value="checkbox">{t("admin.persona.checklist.kind.checkbox")}</option>
            <option value="text">{t("admin.persona.checklist.kind.text")}</option>
            <option value="amount">{t("admin.persona.checklist.kind.amount")}</option>
            <option value="choice">{t("admin.persona.checklist.kind.choice")}</option>
            <option value="section">{t("admin.persona.checklist.kind.section")}</option>
          </select>
          <button
            type="button"
            onClick={onToggleActive}
            disabled={busy}
            className={`text-xs px-2 py-1 rounded border ${
              item.active
                ? "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                : "border-slate-300 text-slate-500 hover:bg-slate-50"
            }`}
          >
            {item.active
              ? t("admin.persona.checklist.activeChip")
              : t("admin.persona.checklist.inactiveChip")}
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="text-xs px-2 py-1 rounded border border-rose-300 text-rose-700 hover:bg-rose-50"
            aria-label={t("common.delete")}
          >×</button>
        </div>
      </div>

      {/* "+ เพิ่มรายการย่อย" — only on top-level rows. Children stay
          flat (no grand-children). Sits as a low-visual-weight link
          under the main row controls so admin only sees it when they
          want it. */}
      {!isChild && onAddChild && (
        <div className="mt-1.5 pl-7">
          <button
            type="button"
            onClick={onAddChild}
            className="text-[11px] text-brand hover:underline"
          >
            + {t("admin.persona.checklist.addChild")}
          </button>
        </div>
      )}

      {/* Options editor — only visible for choice rows. Sits below the
          main row so it doesn't crowd the kind / activate / delete
          controls. PATCH happens once admin moves focus away from each
          input, so quick label-then-options edits don't fire N writes.
          When a choice row has < 2 saved options, we also warn admin
          that staff won't see this row until they finish (matches the
          server-side filter in the staff page queries). */}
      {item.kind === "choice" && (
        <div className="mt-2 pl-7">
          <OptionsEditor
            options={optionsDraft}
            onChange={commitOptions}
            label={t("admin.persona.checklist.kind.optionsLabel")}
            t={t}
          />
          {initialOptions.length < 2 && (
            <p className="text-[11px] text-amber-700 mt-1 font-medium">
              ⚠ {t("admin.persona.checklist.kind.optionsIncomplete")}
            </p>
          )}
        </div>
      )}

      {/* Headline-amount toggle — amount kind only. Admin marks one
          amount row per (branch, type) as "show this big on top of
          the LINE card". The PATCH endpoint auto-clears any other
          headline in the same scope, so the UI doesn't need to
          enforce uniqueness — just refresh and the previous row's
          toggle flips itself off. */}
      {item.kind === "amount" && (
        <div className="mt-2 pl-7">
          <label className="flex items-center gap-2 text-[11px] text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              className="w-4 h-4"
              checked={!!item.is_headline_amount}
              disabled={busy}
              onChange={(e) =>
                onPatchHeadline(e.target.checked ? 1 : 0)
              }
            />
            <span className="font-medium">
              {t("admin.persona.checklist.kind.headlineToggle")}
            </span>
          </label>
          <p className="text-[10px] text-slate-500 pl-6 mt-0.5">
            {t("admin.persona.checklist.kind.headlineHint")}
          </p>
        </div>
      )}

      {/* Description — small free-text under the label on staff form +
          LINE card. Empty hides the line. We PATCH on blur to avoid
          firing on every keystroke. */}
      <div className="mt-2 pl-7">
        <DescriptionEditor
          initial={item.description ?? ""}
          busy={busy}
          onCommit={onPatchDescription}
          t={t}
        />
      </div>
    </div>
  );
}

// Tiny editable textarea for the per-row description. Patches on blur
// (not on every keystroke) so quick typing doesn't fire N writes.
//
// Collapsed by default when the row has no description yet — shows a
// small "+ เพิ่มคำอธิบาย" link instead of an always-empty textarea.
// Each row was taking ~80px of vertical space just to host an empty
// placeholder, which made the editor feel cramped on mobile. Click
// expands to textarea with autofocus; blur with still-empty content
// collapses back. Rows that already have a description render
// expanded so the existing text is visible without an extra click.
function DescriptionEditor({
  initial, busy, onCommit, t
}: {
  initial: string;
  busy: boolean;
  onCommit: (text: string) => Promise<void>;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  const [draft, setDraft] = useState(initial);
  const [expanded, setExpanded] = useState(initial.trim().length > 0);

  // Keep local state in sync if initial changes (e.g. after a refetch
  // that swaps the row). Without this, an admin who saved a value
  // would see the link collapse on the next refresh because draft
  // stayed at the old value while initial advanced.
  useEffect(() => {
    setDraft(initial);
    setExpanded(initial.trim().length > 0);
  }, [initial]);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        disabled={busy}
        className="text-[11px] text-slate-500 hover:text-brand disabled:opacity-40"
      >
        + {t("admin.persona.checklist.descriptionAdd")}
      </button>
    );
  }

  return (
    <div>
      <textarea
        className="input text-[11px] w-full"
        rows={1}
        maxLength={500}
        value={draft}
        // Autofocus only when we just expanded from a previously-empty
        // state — avoids stealing focus on initial mount when a row
        // already has saved description content.
        autoFocus={initial.trim().length === 0}
        disabled={busy}
        placeholder={t("admin.persona.checklist.descriptionPlaceholder")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft.trim() !== initial.trim()) {
            void onCommit(draft);
          }
          // Re-collapse when both saved and draft are empty so the
          // row doesn't keep hosting an empty input after admin
          // changes their mind. Rows with saved content stay
          // expanded so the value remains visible.
          if (draft.trim().length === 0 && initial.trim().length === 0) {
            setExpanded(false);
          }
        }}
      />
    </div>
  );
}

// Reusable editable list of choice options. Each row is one option
// string; admin types into it, can remove with the × button, and adds
// new blanks via "+". Always renders at least 2 rows so the visual cue
// "choice needs at least two options" is present even before admin
// types anything.
function OptionsEditor({
  options, onChange, label, t
}: {
  options: string[];
  onChange: (next: string[]) => void;
  label: string;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  function setAt(idx: number, value: string) {
    onChange(options.map((o, i) => i === idx ? value : o));
  }
  function removeAt(idx: number) {
    // Keep a minimum of 2 rows visible — clear instead of removing
    // the second-to-last slot.
    if (options.length <= 2) {
      onChange(options.map((o, i) => i === idx ? "" : o));
    } else {
      onChange(options.filter((_, i) => i !== idx));
    }
  }
  function add() {
    onChange([...options, ""]);
  }
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-slate-600">{label}</div>
      <div className="space-y-1">
        {options.map((opt, idx) => (
          <div key={idx} className="flex gap-1.5 items-center">
            <input
              type="text"
              className="input text-sm flex-1"
              value={opt}
              placeholder={t("admin.persona.checklist.kind.optionPlaceholder", { n: idx + 1 })}
              maxLength={100}
              onChange={(e) => setAt(idx, e.target.value)}
            />
            <button
              type="button"
              onClick={() => removeAt(idx)}
              className="text-xs text-rose-600 hover:text-rose-700 px-2 py-1"
              aria-label="Remove option"
            >×</button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="text-[11px] text-brand hover:underline mt-0.5"
      >
        + {t("admin.persona.checklist.kind.addOption")}
      </button>
    </div>
  );
}
