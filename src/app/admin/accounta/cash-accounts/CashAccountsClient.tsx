"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { humanizeApiError } from "@/lib/error-messages";

type Account = {
  id: number; branch_id: number | null; name: string; type: string;
  bank_label: string | null; balance: number; balance_as_of: string | null;
  sort_order: number; active: number; note: string | null;
};

function todayBkk(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}
const TH_MON = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
function fmtThaiDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${TH_MON[m]} ${y + 543}`;
}

type Draft = { name: string; type: "cash" | "bank"; bank_label: string; balance: string; balance_as_of: string; company_wide: boolean; note: string };
const emptyDraft = (): Draft => ({ name: "", type: "cash", bank_label: "", balance: "", balance_as_of: todayBkk(), company_wide: false, note: "" });

export default function CashAccountsClient({
  initialAccounts, branchName
}: { initialAccounts: Account[]; branchName: string }) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>(initialAccounts);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft());

  const activeTotal = accounts.filter((a) => a.active).reduce((s, a) => s + a.balance, 0);

  async function call(method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>, qs?: string) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/cash-accounts${qs ?? ""}`), {
        method, headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return false; }
      if (j.accounts) setAccounts(j.accounts);
      router.refresh();
      return true;
    } finally { setBusy(false); }
  }

  function draftToBody(d: Draft) {
    return {
      name: d.name.trim(), type: d.type,
      bank_label: d.bank_label.trim() || undefined,
      balance: d.balance.trim() === "" ? 0 : Number(d.balance),
      balance_as_of: d.balance_as_of || undefined,
      note: d.note.trim() || undefined
    };
  }

  async function add() {
    if (!draft.name.trim()) return;
    if (await call("POST", { ...draftToBody(draft), company_wide: draft.company_wide })) {
      setDraft(emptyDraft()); setAdding(false);
    }
  }
  function startEdit(a: Account) {
    setEditId(a.id);
    setEditDraft({
      name: a.name, type: a.type === "bank" ? "bank" : "cash", bank_label: a.bank_label ?? "",
      balance: String(a.balance), balance_as_of: a.balance_as_of ?? todayBkk(),
      company_wide: a.branch_id == null, note: a.note ?? ""
    });
  }
  async function saveEdit(id: number) {
    if (await call("PATCH", { id, ...draftToBody(editDraft) })) setEditId(null);
  }

  const Form = ({ d, set, onSave, onCancel, saveLabel, allowScope }: {
    d: Draft; set: (d: Draft) => void; onSave: () => void; onCancel: () => void; saveLabel: string; allowScope: boolean;
  }) => (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="label">ชื่อบัญชี</label>
          <input className="input" value={d.name} maxLength={80} placeholder="เช่น เงินสดหน้าร้าน / กสิกร 1234"
            onChange={(e) => set({ ...d, name: e.target.value })} />
        </div>
        <div>
          <label className="label">ประเภท</label>
          <select className="input" value={d.type} onChange={(e) => set({ ...d, type: e.target.value as "cash" | "bank" })}>
            <option value="cash">เงินสด</option>
            <option value="bank">บัญชีธนาคาร</option>
          </select>
        </div>
        {d.type === "bank" && (
          <div className="sm:col-span-2">
            <label className="label">ธนาคาร / เลขบัญชี (ถ้ามี)</label>
            <input className="input" value={d.bank_label} maxLength={80} placeholder="เช่น กสิกรไทย · xxx-x-x1234-x"
              onChange={(e) => set({ ...d, bank_label: e.target.value })} />
          </div>
        )}
        <div>
          <label className="label">ยอดคงเหลือ (บาท)</label>
          <input type="number" inputMode="decimal" step="0.01" className="input" value={d.balance} placeholder="0.00"
            onChange={(e) => set({ ...d, balance: e.target.value })} />
        </div>
        <div>
          <label className="label">ยอด ณ วันที่</label>
          <input type="date" className="input" value={d.balance_as_of}
            onChange={(e) => set({ ...d, balance_as_of: e.target.value })} />
        </div>
      </div>
      {allowScope && (
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={d.company_wide} onChange={(e) => set({ ...d, company_wide: e.target.checked })} />
          เป็นบัญชีของทั้งบริษัท (เห็นในทุกสาขา)
        </label>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={onSave} disabled={busy || !d.name.trim()}
          className="btn-primary text-sm disabled:opacity-50">{saveLabel}</button>
        <button type="button" onClick={onCancel} disabled={busy} className="btn-secondary text-sm">ยกเลิก</button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-rose-600">{err}</p>}

      {/* Total */}
      <div className="card flex items-center justify-between py-3">
        <div>
          <div className="text-[11px] text-slate-400">เงินคงเหลือรวม (สาขา {branchName} + ทั้งบริษัท)</div>
          <div className="text-2xl font-bold text-slate-800">฿{fmtMoney(activeTotal)}</div>
        </div>
        {!adding && (
          <button type="button" onClick={() => { setDraft(emptyDraft()); setAdding(true); }}
            className="btn-primary text-sm">+ เพิ่มบัญชี</button>
        )}
      </div>

      {/* Add form */}
      {adding && (
        <div className="card space-y-2">
          <div className="text-sm font-bold text-slate-800">เพิ่มบัญชีเงินสด/ธนาคาร</div>
          <Form d={draft} set={setDraft} onSave={add} onCancel={() => setAdding(false)} saveLabel="เพิ่มบัญชี" allowScope />
        </div>
      )}

      {/* Accounts */}
      {accounts.length === 0 ? (
        <div className="card text-sm text-slate-400">ยังไม่มีบัญชี — กด “+ เพิ่มบัญชี” เพื่อเริ่มติดตามยอดเงิน</div>
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => (
            <div key={a.id} className={`card space-y-2 ${a.active ? "" : "opacity-60"}`}>
              {editId === a.id ? (
                <Form d={editDraft} set={setEditDraft} onSave={() => saveEdit(a.id)} onCancel={() => setEditId(null)} saveLabel="บันทึก" allowScope={false} />
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-slate-800">{a.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{a.type === "bank" ? "ธนาคาร" : "เงินสด"}</span>
                      {a.branch_id == null && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">ทั้งบริษัท</span>}
                      {!a.active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-400">ปิดใช้งาน</span>}
                    </div>
                    {a.bank_label && <div className="text-[11px] text-slate-400">{a.bank_label}</div>}
                    <div className="text-[11px] text-slate-400">ยอด ณ {fmtThaiDate(a.balance_as_of)}{a.note ? ` · ${a.note}` : ""}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xl font-bold text-slate-800">฿{fmtMoney(a.balance)}</div>
                    <div className="flex items-center gap-2 justify-end mt-1">
                      <button type="button" onClick={() => startEdit(a)} disabled={busy} className="text-[11px] text-brand hover:underline">แก้ไข</button>
                      <button type="button" onClick={() => call("PATCH", { id: a.id, active: !a.active })} disabled={busy}
                        className="text-[11px] text-slate-500 hover:underline">{a.active ? "ปิดใช้งาน" : "เปิดใช้งาน"}</button>
                      <button type="button"
                        onClick={() => { if (window.confirm(`ลบบัญชี "${a.name}" ? กู้คืนไม่ได้`)) call("DELETE", undefined, `?id=${a.id}`); }}
                        disabled={busy} className="text-[11px] text-rose-500 hover:underline">ลบ</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
