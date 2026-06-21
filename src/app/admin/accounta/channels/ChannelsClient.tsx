"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";

type Channel = { id: number; name: string; sort_order: number; active: number; show_on_close: number };

export default function ChannelsClient({
  initialChannels, defaults = []
}: { initialChannels: Channel[]; defaults?: string[] }) {
  const router = useRouter();
  const [channels, setChannels] = useState<Channel[]>(initialChannels);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  async function call(method: "POST" | "PATCH", body: Record<string, unknown>) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/accounta/income-channels"), {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return false; }
      if (j.channels) setChannels(j.channels);
      router.refresh();
      return true;
    } finally { setBusy(false); }
  }

  async function add() {
    const name = newName.trim();
    if (!name) return;
    if (await call("POST", { name })) setNewName("");
  }
  async function saveRename(id: number) {
    const name = editName.trim();
    if (!name) { setEditId(null); return; }
    if (await call("PATCH", { id, name })) setEditId(null);
  }

  const active = channels.filter((c) => c.active);
  const inactive = channels.filter((c) => !c.active);

  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-rose-600">{err}</p>}

      {/* Empty-state — offer to seed from the shared defaults */}
      {channels.length === 0 && defaults.length > 0 && (
        <div className="card bg-amber-50 border border-amber-200 space-y-2">
          <div className="text-sm font-bold text-amber-800">สาขานี้ยังไม่ได้ตั้งช่องทางของตัวเอง</div>
          <p className="text-xs text-amber-700">
            ตอนนี้ใช้ค่าเริ่มต้นรวม: {defaults.join(" · ")} — กดเพื่อคัดลอกมาเป็นของสาขานี้แล้วปรับ หรือเพิ่มเองด้านล่าง
          </p>
          <button type="button" onClick={() => call("PATCH", { copy_defaults: true })} disabled={busy}
            className="btn-secondary text-sm w-fit disabled:opacity-50">คัดลอกค่าเริ่มต้นมาเริ่ม</button>
        </div>
      )}

      {/* Add */}
      <div className="card flex flex-col sm:flex-row gap-2">
        <input
          className="input flex-1"
          value={newName}
          maxLength={60}
          placeholder="ชื่อช่องทางใหม่ เช่น เงินสด / PromptPay / VISA / Grab"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
        <button type="button" onClick={add} disabled={busy || !newName.trim()}
          className="btn-primary whitespace-nowrap disabled:opacity-50">+ เพิ่มช่องทาง</button>
      </div>

      {/* Active list (ordered — this is the order shown on the close form) */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">ช่องทางที่ใช้งาน ({active.length})</div>
        <p className="text-[11px] text-slate-400">เฉพาะช่องทางที่ติด “✓ ขึ้นปิดกะ” จะให้น้องกรอกในรายงานปิดกะ (เรียงตามลำดับนี้) · ช่องทางอื่นยังใช้ลงรายรับมือได้</p>
        {active.length === 0 ? (
          <p className="text-xs text-slate-400">ยังไม่มีช่องทาง</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {active.map((c, i) => (
              <li key={c.id} className="flex items-center gap-2 py-2">
                <div className="flex flex-col">
                  <button type="button" onClick={() => call("PATCH", { id: c.id, move: "up" })}
                    disabled={busy || i === 0}
                    className="text-xs px-1.5 text-slate-500 hover:text-brand disabled:opacity-30" aria-label="ขึ้น">▲</button>
                  <button type="button" onClick={() => call("PATCH", { id: c.id, move: "down" })}
                    disabled={busy || i === active.length - 1}
                    className="text-xs px-1.5 text-slate-500 hover:text-brand disabled:opacity-30" aria-label="ลง">▼</button>
                </div>
                {editId === c.id ? (
                  <input
                    className="input flex-1 text-sm" autoFocus value={editName} maxLength={60}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => saveRename(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); saveRename(c.id); }
                      if (e.key === "Escape") setEditId(null);
                    }}
                  />
                ) : (
                  <button type="button" onClick={() => { setEditId(c.id); setEditName(c.name); }}
                    className="flex-1 text-left text-sm text-slate-800 hover:text-brand">{c.name}</button>
                )}
                <button type="button"
                  onClick={() => call("PATCH", { id: c.id, show_on_close: !c.show_on_close })}
                  disabled={busy}
                  title="แสดงให้น้องกรอกในรายงานปิดกะหรือไม่"
                  className={`text-[11px] px-2 py-1 rounded border ${
                    c.show_on_close
                      ? "border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
                      : "border-slate-300 text-slate-400 hover:bg-slate-50"
                  }`}>
                  {c.show_on_close ? "✓ ขึ้นปิดกะ" : "ไม่ขึ้นปิดกะ"}
                </button>
                <button type="button" onClick={() => call("PATCH", { id: c.id, active: false })}
                  disabled={busy}
                  className="text-[11px] px-2 py-1 rounded border border-slate-300 text-slate-500 hover:bg-slate-50">ปิดใช้งาน</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Inactive list */}
      {inactive.length > 0 && (
        <div className="card space-y-2">
          <div className="text-sm font-bold text-slate-500">ปิดใช้งานแล้ว ({inactive.length})</div>
          <p className="text-[11px] text-slate-400">ไม่แสดงในฟอร์มปิดกะ แต่ประวัติรายรับเดิมยังอยู่ครบ</p>
          <ul className="divide-y divide-slate-100">
            {inactive.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2">
                <span className="text-sm text-slate-400 line-through">{c.name}</span>
                <button type="button" onClick={() => call("PATCH", { id: c.id, active: true })}
                  disabled={busy}
                  className="text-[11px] px-2 py-1 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50">เปิดใช้งาน</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
