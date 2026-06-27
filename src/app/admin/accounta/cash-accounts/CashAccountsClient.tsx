"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { humanizeApiError } from "@/lib/error-messages";
import { useConfirm } from "@/app/components/useConfirm";

type AccType = "cash" | "bank" | "ewallet" | "credit_card";
type Account = {
  id: number; branch_id: number | null; name: string; type: string;
  bank_label: string | null; balance: number; balance_as_of: string | null;
  sort_order: number; active: number; note: string | null;
  bank_name: string | null; account_type: string | null; account_name: string | null;
  account_no: string | null; account_branch: string | null; account_branch_no: string | null;
  description: string | null; card_last4: string | null;
  use_income: number; use_expense: number;
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

const TYPE_LABEL: Record<AccType, string> = {
  cash: "เงินสด", bank: "บัญชีธนาคาร", ewallet: "e-Wallet", credit_card: "บัตรเครดิตกรรมการ"
};

type Draft = {
  name: string; type: AccType; bank_label: string; balance: string; balance_as_of: string;
  company_wide: boolean; note: string;
  bank_name: string; account_type: string; account_name: string; account_no: string;
  account_branch: string; account_branch_no: string; description: string; card_last4: string;
  use_income: boolean; use_expense: boolean;
};
const emptyDraft = (): Draft => ({
  name: "", type: "cash", bank_label: "", balance: "", balance_as_of: todayBkk(),
  company_wide: false, note: "",
  bank_name: "", account_type: "", account_name: "", account_no: "",
  account_branch: "", account_branch_no: "", description: "", card_last4: "",
  use_income: true, use_expense: true
});

export default function CashAccountsClient({
  initialAccounts, branchName
}: { initialAccounts: Account[]; branchName: string }) {
  const { confirm, ConfirmDialog } = useConfirm();
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
    const isBank = d.type === "bank";
    const isCard = d.type === "credit_card";
    return {
      name: d.name.trim(), type: d.type,
      bank_label: isBank ? (d.bank_label.trim() || null) : null,
      balance: d.balance.trim() === "" ? 0 : Number(d.balance),
      balance_as_of: d.balance_as_of || undefined,
      note: d.note.trim() || null,
      bank_name: (isBank || isCard) ? (d.bank_name.trim() || null) : null,
      account_type: isBank ? (d.account_type.trim() || null) : null,
      account_name: isBank ? (d.account_name.trim() || null) : null,
      account_no: isBank ? (d.account_no.trim() || null) : null,
      account_branch: isBank ? (d.account_branch.trim() || null) : null,
      account_branch_no: isBank ? (d.account_branch_no.trim() || null) : null,
      description: d.description.trim() || null,
      card_last4: isCard ? (d.card_last4.replace(/\D/g, "").slice(-4) || null) : null,
      use_income: d.use_income, use_expense: d.use_expense
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
      name: a.name, type: (["cash", "bank", "ewallet", "credit_card"].includes(a.type) ? a.type : "cash") as AccType,
      bank_label: a.bank_label ?? "", balance: String(a.balance), balance_as_of: a.balance_as_of ?? todayBkk(),
      company_wide: a.branch_id == null, note: a.note ?? "",
      bank_name: a.bank_name ?? "", account_type: a.account_type ?? "", account_name: a.account_name ?? "",
      account_no: a.account_no ?? "", account_branch: a.account_branch ?? "", account_branch_no: a.account_branch_no ?? "",
      description: a.description ?? "", card_last4: a.card_last4 ?? "",
      use_income: a.use_income === 1, use_expense: a.use_expense === 1
    });
  }
  async function saveEdit(id: number) {
    if (await call("PATCH", { id, ...draftToBody(editDraft) })) setEditId(null);
  }

  const Form = ({ d, set, onSave, onCancel, saveLabel, allowScope }: {
    d: Draft; set: (d: Draft) => void; onSave: () => void; onCancel: () => void; saveLabel: string; allowScope: boolean;
  }) => (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="label">ประเภทช่องทางการเงิน</label>
          <select className="input" value={d.type} onChange={(e) => set({ ...d, type: e.target.value as AccType })}>
            <option value="cash">เงินสด</option>
            <option value="bank">บัญชีธนาคาร</option>
            <option value="ewallet">e-Wallet</option>
            <option value="credit_card">บัตรเครดิตกรรมการ</option>
          </select>
        </div>
        <div>
          <label className="label">ชื่อช่องทาง (ที่แสดงในระบบ)</label>
          <input className="input" value={d.name} maxLength={80}
            placeholder={d.type === "credit_card" ? "เช่น บัตรเครดิตกรรมการ" : d.type === "bank" ? "เช่น SCB อิคิไก" : "เช่น เงินสดหน้าร้าน"}
            onChange={(e) => set({ ...d, name: e.target.value })} />
        </div>

        {/* Bank detail */}
        {d.type === "bank" && (<>
          <div>
            <label className="label">ธนาคาร</label>
            <input className="input" value={d.bank_name} maxLength={80} placeholder="เช่น ธ.ไทยพาณิชย์"
              onChange={(e) => set({ ...d, bank_name: e.target.value })} />
          </div>
          <div>
            <label className="label">ประเภทบัญชี</label>
            <input className="input" value={d.account_type} maxLength={40} placeholder="เช่น ออมทรัพย์ / กระแสรายวัน"
              onChange={(e) => set({ ...d, account_type: e.target.value })} />
          </div>
          <div>
            <label className="label">ชื่อบัญชี</label>
            <input className="input" value={d.account_name} maxLength={120} placeholder="เช่น บริษัท อิคิไก เวลล์เทรด จำกัด"
              onChange={(e) => set({ ...d, account_name: e.target.value })} />
          </div>
          <div>
            <label className="label">เลขบัญชี</label>
            <input className="input" value={d.account_no} maxLength={40} placeholder="เช่น 4181388595"
              onChange={(e) => set({ ...d, account_no: e.target.value })} />
          </div>
          <div>
            <label className="label">ชื่อสาขา</label>
            <input className="input" value={d.account_branch} maxLength={80} placeholder="เช่น เทสโก้ โลตัส บ่อวิน"
              onChange={(e) => set({ ...d, account_branch: e.target.value })} />
          </div>
          <div>
            <label className="label">เลขที่สาขา</label>
            <input className="input" value={d.account_branch_no} maxLength={20} placeholder="(ถ้ามี)"
              onChange={(e) => set({ ...d, account_branch_no: e.target.value })} />
          </div>
        </>)}

        {/* Credit-card detail — last 4 only, no full number */}
        {d.type === "credit_card" && (<>
          <div>
            <label className="label">ธนาคาร / ผู้ออกบัตร</label>
            <input className="input" value={d.bank_name} maxLength={80} placeholder="เช่น KTC / SCB"
              onChange={(e) => set({ ...d, bank_name: e.target.value })} />
          </div>
          <div>
            <label className="label">เลข 4 ตัวท้าย</label>
            <input className="input font-mono" value={d.card_last4} inputMode="numeric" maxLength={4} placeholder="1234"
              onChange={(e) => set({ ...d, card_last4: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
            <p className="text-[10px] text-slate-400 mt-0.5">เพื่อความปลอดภัย ระบบเก็บเฉพาะ 4 ตัวท้าย — ไม่เก็บเลขบัตรเต็มหรือ CVV</p>
          </div>
        </>)}

        <div>
          <label className="label">{d.type === "credit_card" ? "ยอดใช้ไป/วงเงินคงเหลือ (บาท)" : "ยอดคงเหลือ (บาท)"}</label>
          <input type="number" inputMode="decimal" step="0.01" className="input" value={d.balance} placeholder="0.00"
            onChange={(e) => set({ ...d, balance: e.target.value })} />
        </div>
        <div>
          <label className="label">ยอด ณ วันที่</label>
          <input type="date" className="input" value={d.balance_as_of}
            onChange={(e) => set({ ...d, balance_as_of: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">คำอธิบาย (ถ้ามี)</label>
          <input className="input" value={d.description} maxLength={300} placeholder="หมายเหตุช่องทางนี้"
            onChange={(e) => set({ ...d, description: e.target.value })} />
        </div>
      </div>

      {/* รับ / จ่าย flags */}
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={d.use_income} onChange={(e) => set({ ...d, use_income: e.target.checked })} />
          ใช้รับเงิน (รายรับ)
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={d.use_expense} onChange={(e) => set({ ...d, use_expense: e.target.checked })} />
          ใช้จ่ายเงิน (รายจ่าย)
        </label>
      </div>

      {allowScope && (
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={d.company_wide} onChange={(e) => set({ ...d, company_wide: e.target.checked })} />
          เป็นช่องทางของทั้งบริษัท (เห็นในทุกสาขา)
        </label>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={onSave} disabled={busy || !d.name.trim()}
          className="btn-primary text-sm disabled:opacity-50">{saveLabel}</button>
        <button type="button" onClick={onCancel} disabled={busy} className="btn-secondary text-sm">ยกเลิก</button>
      </div>
    </div>
  );

  const subLabel = (a: Account): string | null => {
    if (a.type === "credit_card") {
      const parts = [a.bank_name, a.card_last4 ? `···${a.card_last4}` : null].filter(Boolean);
      return parts.length ? parts.join(" · ") : null;
    }
    if (a.type === "bank") {
      const parts = [a.bank_name || a.bank_label, a.account_type, a.account_no].filter(Boolean);
      return parts.length ? parts.join(" · ") : null;
    }
    return a.description || null;
  };

  return (
    <div className="space-y-4">
      {ConfirmDialog}
      {err && <p className="text-sm text-rose-600">{err}</p>}

      {/* Total */}
      <div className="card flex items-center justify-between py-3">
        <div>
          <div className="text-[11px] text-slate-400">เงินคงเหลือรวม (สาขา {branchName} + ทั้งบริษัท)</div>
          <div className="text-2xl font-bold text-slate-800">฿{fmtMoney(activeTotal)}</div>
        </div>
        {!adding && (
          <button type="button" onClick={() => { setDraft(emptyDraft()); setAdding(true); }}
            className="btn-primary text-sm">+ เพิ่มช่องทาง</button>
        )}
      </div>

      {/* Add form */}
      {adding && (
        <div className="card space-y-2">
          <div className="text-sm font-bold text-slate-800">เพิ่มช่องทางการเงิน</div>
          <Form d={draft} set={setDraft} onSave={add} onCancel={() => setAdding(false)} saveLabel="เพิ่มช่องทาง" allowScope />
        </div>
      )}

      {/* Accounts */}
      {accounts.length === 0 ? (
        <div className="card text-sm text-slate-400">ยังไม่มีช่องทาง — กด “+ เพิ่มช่องทาง” เพื่อเริ่มตั้งค่าบัญชี/บัตร</div>
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
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{TYPE_LABEL[(["cash", "bank", "ewallet", "credit_card"].includes(a.type) ? a.type : "cash") as AccType]}</span>
                      {a.branch_id == null && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">ทั้งบริษัท</span>}
                      {!!a.use_income && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600">รับเงิน</span>}
                      {!!a.use_expense && <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-600">จ่ายเงิน</span>}
                      {!a.active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-400">ปิดใช้งาน</span>}
                    </div>
                    {subLabel(a) && <div className="text-[11px] text-slate-400">{subLabel(a)}</div>}
                    <div className="text-[11px] text-slate-400">ยอด ณ {fmtThaiDate(a.balance_as_of)}{a.note ? ` · ${a.note}` : ""}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xl font-bold text-slate-800">฿{fmtMoney(a.balance)}</div>
                    <div className="flex items-center gap-2 justify-end mt-1">
                      <button type="button" onClick={() => startEdit(a)} disabled={busy} className="text-[11px] text-brand hover:underline">แก้ไข</button>
                      <button type="button" onClick={() => call("PATCH", { id: a.id, active: !a.active })} disabled={busy}
                        className="text-[11px] text-slate-500 hover:underline">{a.active ? "ปิดใช้งาน" : "เปิดใช้งาน"}</button>
                      <button type="button"
                        onClick={async () => { const ok = await confirm({ title: "ยืนยันการลบ", body: `ลบช่องทาง "${a.name}" ? กู้คืนไม่ได้`, confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger" }); if (ok !== null) call("DELETE", undefined, `?id=${a.id}`); }}
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
