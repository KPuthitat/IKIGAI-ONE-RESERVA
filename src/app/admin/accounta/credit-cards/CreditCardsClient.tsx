"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney, grpMoney, parseMoney } from "@/lib/format";
import { round2 } from "@/lib/accounta";
import { humanizeApiError } from "@/lib/error-messages";
import Select from "@/app/components/Select";
import { useConfirm } from "@/app/components/useConfirm";

type Charge = {
  id: number; card_id: number | null; card_name: string | null; merchant: string | null;
  description: string | null; purchase_date: string; total_amount: number; installments: number;
  first_due_month: string; note: string | null;
};
type Reserve = {
  card_id: number | null; card_name: string; bank_label: string | null; last4: string | null;
  months: string[]; byMonth: Record<string, number>; thisMonth: number; outstanding: number; charges: Charge[];
};
type Card = { id: number; name: string; bank_label: string | null; last4: string | null };

const TH_MON = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
function monthShort(ym: string): string { const [y, m] = ym.split("-").map(Number); return `${TH_MON[m]} ${String(y + 543).slice(2)}`; }
function addMonth(ym: string, n: number): string { const [y, m] = ym.split("-").map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; }

type Form = {
  id: number | null; card_id: string; merchant: string; description: string; purchase_date: string;
  amount: string; mode: "full" | "installment"; installments: string; first_due_month: string; note: string;
};
function todayISO() { return new Date().toISOString().slice(0, 10); }
function blank(cardId: string, curMonth: string): Form {
  return { id: null, card_id: cardId, merchant: "", description: "", purchase_date: todayISO(),
    amount: "", mode: "full", installments: "3", first_due_month: addMonth(curMonth, 1), note: "" };
}

export default function CreditCardsClient({
  branchId, currentMonth, cards, initialReserve
}: {
  branchId: number; currentMonth: string; cards: Card[]; initialReserve: Reserve[];
}) {
  const router = useRouter();
  const { confirm, ConfirmDialog } = useConfirm();
  const [reserve, setReserve] = useState<Reserve[]>(initialReserve);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(blank(cards[0] ? String(cards[0].id) : "", currentMonth));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const total = parseMoney(form.amount) || 0;
  const inst = form.mode === "full" ? 1 : Math.max(1, Number(form.installments) || 1);

  async function reload() {
    const r = await fetch(apiUrl(`/api/accounta/cc-charges?branch=${branchId}`));
    const j = await r.json().catch(() => ({}));
    if (j.ok) setReserve(j.reserve);
  }

  function openNew(cardId?: number) { setForm(blank(cardId ? String(cardId) : (cards[0] ? String(cards[0].id) : ""), currentMonth)); setErr(null); setOpen(true); }
  function openEdit(c: Charge) {
    setForm({
      id: c.id, card_id: c.card_id ? String(c.card_id) : "", merchant: c.merchant ?? "", description: c.description ?? "",
      purchase_date: c.purchase_date, amount: grpMoney(String(c.total_amount)),
      mode: c.installments > 1 ? "installment" : "full", installments: String(c.installments > 1 ? c.installments : 3),
      first_due_month: c.first_due_month, note: c.note ?? ""
    });
    setErr(null); setOpen(true);
  }

  async function save() {
    if (!form.card_id) { setErr("เลือกบัตร"); return; }
    if (!(total > 0)) { setErr("กรอกยอดเงินให้ถูกต้อง"); return; }
    if (!/^\d{4}-\d{2}$/.test(form.first_due_month)) { setErr("เลือกเดือนที่ธนาคารเริ่มเรียกเก็บ"); return; }
    setBusy(true); setErr(null);
    try {
      const card = cards.find((c) => String(c.id) === form.card_id);
      const body = {
        branch_id: branchId, card_id: Number(form.card_id), card_name: card?.name ?? null,
        merchant: form.merchant.trim() || null, description: form.description.trim() || null,
        purchase_date: form.purchase_date, total_amount: round2(total), installments: inst,
        first_due_month: form.first_due_month, note: form.note.trim() || null
      };
      const res = await fetch(apiUrl(form.id ? `/api/accounta/cc-charges/${form.id}` : "/api/accounta/cc-charges"), {
        method: form.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      setOpen(false); await reload(); router.refresh();
    } finally { setBusy(false); }
  }

  async function remove(c: Charge) {
    const ok = await confirm({ title: "ลบรายการรูดบัตร", body: `ลบ "${c.merchant ?? c.description ?? "รายการนี้"}" ฿${fmtMoney(c.total_amount)} ?`, confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger" });
    if (ok === null) return;
    await fetch(apiUrl(`/api/accounta/cc-charges/${c.id}`), { method: "DELETE" });
    await reload(); router.refresh();
  }

  return (
    <div className="space-y-4">
      {ConfirmDialog}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm text-slate-500">
          {cards.length === 0 ? "ยังไม่มีบัตรเครดิตในระบบ — เพิ่มบัตรที่หน้า “ช่องทางการเงิน / บัญชี” ก่อน" : ""}
        </div>
        <button type="button" onClick={() => openNew()} disabled={cards.length === 0}
          className="rounded-md bg-rose-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-rose-700 disabled:opacity-50">+ เพิ่มรายการรูดบัตร</button>
      </div>

      {reserve.length === 0 ? (
        <div className="card text-sm text-slate-400">ยังไม่มีบัตรเครดิตกรรมการ</div>
      ) : reserve.map((g) => (
        <div key={g.card_id ?? g.card_name} className="card space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="font-bold text-slate-800">{g.card_name}{g.last4 ? ` ····${g.last4}` : ""}</div>
              {g.bank_label && <div className="text-[11px] text-slate-400">{g.bank_label}</div>}
            </div>
            <div className="flex gap-4 text-right">
              <div>
                <div className="text-[11px] text-slate-400">ต้องเตรียมรวม (กันไว้จ่ายธนาคาร)</div>
                <div className="text-xl font-bold text-rose-700 font-mono">฿{fmtMoney(g.outstanding)}</div>
              </div>
              <div>
                <div className="text-[11px] text-slate-400">งวดเดือนนี้</div>
                <div className="text-xl font-bold text-slate-800 font-mono">฿{fmtMoney(g.thisMonth)}</div>
              </div>
            </div>
          </div>

          {g.months.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-xs tabular-nums">
                <thead>
                  <tr className="text-slate-400">
                    <th className="text-left pr-3 py-1 font-normal">เดือน</th>
                    {g.months.map((m) => (
                      <th key={m} className={`px-3 py-1 text-right font-normal whitespace-nowrap ${m === currentMonth ? "text-rose-700 font-bold" : ""}`}>{monthShort(m)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-slate-100">
                    <td className="text-left pr-3 py-1.5 text-slate-500 whitespace-nowrap">ต้องโอนไปเตรียม</td>
                    {g.months.map((m) => (
                      <td key={m} className={`px-3 py-1.5 text-right font-mono whitespace-nowrap ${m === currentMonth ? "bg-rose-50 text-rose-700 font-bold rounded" : "text-slate-700"} ${(g.byMonth[m] ?? 0) === 0 ? "text-slate-300" : ""}`}>
                        {fmtMoney(g.byMonth[m] ?? 0)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div className="border-t border-slate-100 pt-2 space-y-1">
            {g.charges.length === 0 ? (
              <p className="text-xs text-slate-400">ยังไม่มีรายการรูดบัตรของใบนี้</p>
            ) : g.charges.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <div className="text-slate-700 truncate">{c.merchant || c.description || "—"}</div>
                  <div className="text-[11px] text-slate-400">
                    {c.purchase_date} · {c.installments > 1 ? `ผ่อน ${c.installments} งวด (฿${fmtMoney(c.total_amount / c.installments)}/ด.)` : "จ่ายเต็ม"} · เริ่ม {monthShort(c.first_due_month)}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="font-mono text-rose-700">฿{fmtMoney(c.total_amount)}</span>
                  <button type="button" onClick={() => openEdit(c)} className="text-xs text-slate-500 hover:text-brand">แก้ไข</button>
                  <button type="button" onClick={() => remove(c)} className="text-xs text-slate-400 hover:text-rose-600">ลบ</button>
                </div>
              </div>
            ))}
            <button type="button" onClick={() => openNew(g.card_id ?? undefined)} className="text-xs text-brand hover:underline">+ เพิ่มรายการในบัตรนี้</button>
          </div>
        </div>
      ))}

      {open && (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
              <div className="text-sm font-bold text-slate-800">{form.id ? "แก้ไขรายการรูดบัตร" : "เพิ่มรายการรูดบัตร"}</div>
              <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600 text-lg leading-none">✕</button>
            </div>
            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3.5">
              <div className="sm:col-span-2">
                <label className="label !text-xs">บัตร</label>
                <Select value={form.card_id} onChange={(v) => set("card_id", v)} placeholder="— เลือกบัตร —"
                  options={cards.map((c) => ({ value: String(c.id), label: `${c.name}${c.last4 ? ` ····${c.last4}` : ""}${c.bank_label ? ` · ${c.bank_label}` : ""}` }))} />
              </div>
              <div>
                <label className="label !text-xs">ร้าน / ที่รูด</label>
                <input className="input" value={form.merchant} onChange={(e) => set("merchant", e.target.value)} placeholder="เช่น MAKRO" />
              </div>
              <div>
                <label className="label !text-xs">วันที่รูด</label>
                <input type="date" className="input" value={form.purchase_date} onChange={(e) => set("purchase_date", e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="label !text-xs">รายละเอียด</label>
                <input className="input" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="เช่น วัตถุดิบ/อุปกรณ์" />
              </div>
              <div>
                <label className="label !text-xs">ยอดรวมที่รูด</label>
                <input type="text" inputMode="decimal" className="input text-right font-mono" value={form.amount} onChange={(e) => set("amount", grpMoney(e.target.value))} />
              </div>
              <div>
                <label className="label !text-xs">การชำระ</label>
                <Select value={form.mode} onChange={(v) => set("mode", v as "full" | "installment")}
                  options={[{ value: "full", label: "จ่ายเต็ม (1 งวด)" }, { value: "installment", label: "ผ่อน" }]} />
              </div>
              {form.mode === "installment" && (
                <div>
                  <label className="label !text-xs">จำนวนงวด (เดือน)</label>
                  <input type="number" min={2} max={60} className="input" value={form.installments} onChange={(e) => set("installments", e.target.value)} />
                </div>
              )}
              <div>
                <label className="label !text-xs">เดือนที่ธนาคารเริ่มเรียกเก็บ</label>
                <input type="month" className="input" value={form.first_due_month} onChange={(e) => set("first_due_month", e.target.value)} />
              </div>
              {total > 0 && (
                <div className="sm:col-span-2 text-[11px] text-slate-500">
                  {inst > 1 ? `ผ่อน ${inst} งวด ≈ ฿${fmtMoney(total / inst)}/เดือน` : `จ่ายเต็ม ฿${fmtMoney(total)}`} · เริ่ม {monthShort(form.first_due_month || currentMonth)}
                </div>
              )}
              <div className="sm:col-span-2">
                <label className="label !text-xs">หมายเหตุ</label>
                <input className="input" value={form.note} onChange={(e) => set("note", e.target.value)} placeholder="เว้นว่างได้" />
              </div>
              {err && <div className="sm:col-span-2 text-xs text-rose-600">{err}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100">
              <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-slate-300 bg-white text-slate-600 px-5 py-2 text-sm font-medium hover:bg-slate-50">ยกเลิก</button>
              <button type="button" onClick={save} disabled={busy} className="rounded-md bg-brand text-white px-5 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50">
                {busy ? "กำลังบันทึก…" : "บันทึก"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
