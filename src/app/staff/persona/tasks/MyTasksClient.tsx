"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { MyActionItem } from "@/lib/meetings";

export default function MyTasksClient({ items }: { items: MyActionItem[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

  async function toggle(item: MyActionItem) {
    setBusyId(item.id);
    try {
      await fetch(apiUrl(`/api/persona/meeting-items/${item.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: item.status === "open" ? "done" : "reopen" })
      });
      startTransition(() => router.refresh());
    } finally { setBusyId(null); }
  }

  const open = items.filter((i) => i.status === "open");
  const done = items.filter((i) => i.status === "done");

  if (items.length === 0) {
    return <div className="card text-sm text-slate-400 text-center py-8">ยังไม่มีงานที่ได้รับมอบหมาย</div>;
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-1.5">
        <h2 className="font-bold text-slate-800 text-sm">ค้างอยู่ ({open.length})</h2>
        {open.length === 0 && <p className="text-sm text-slate-400">ไม่มีงานค้าง</p>}
        {open.map((it) => (
          <Row key={it.id} item={it} today={today} busy={busyId === it.id} onToggle={() => toggle(it)} />
        ))}
      </div>

      {done.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-medium text-slate-500 select-none">
            เสร็จแล้ว ({done.length})
          </summary>
          <div className="space-y-1.5 mt-2">
            {done.map((it) => (
              <Row key={it.id} item={it} today={today} busy={busyId === it.id} onToggle={() => toggle(it)} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Row({
  item, today, busy, onToggle
}: { item: MyActionItem; today: string; busy: boolean; onToggle: () => void }) {
  const done = item.status === "done";
  const overdue = !done && item.due_date != null && item.due_date < today;
  return (
    <div className="flex items-center gap-2.5 text-sm border-t border-slate-100 pt-2 first:border-t-0">
      <button type="button" disabled={busy} onClick={onToggle}
        className={`shrink-0 w-6 h-6 rounded border flex items-center justify-center ${
          done ? "bg-emerald-500 border-emerald-500 text-white" : "border-slate-300 text-transparent hover:border-emerald-400"
        }`}>
        ✓
      </button>
      <div className="flex-1 min-w-0">
        <span className={done ? "line-through text-slate-400" : "text-slate-800 font-medium"}>{item.title}</span>
        <div className="flex flex-wrap gap-x-2 text-[11px] text-slate-400">
          <span>{item.meeting_title} · {item.meeting_date}</span>
          {item.due_date && (
            <span className={overdue ? "text-rose-500 font-medium" : ""}>
              กำหนด {item.due_date}{overdue ? " · เลยกำหนด" : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
