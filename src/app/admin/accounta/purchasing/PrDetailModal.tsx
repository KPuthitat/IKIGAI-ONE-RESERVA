"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtMoney } from "@/lib/format";
import { apiUrl } from "@/lib/url";
import PinPromptModal from "@/app/components/PinPromptModal";
import { api, KIND_LABEL, STATUS, type Detail, type Overview } from "./types";

const URL_ = "/api/admin/accounta/purchasing";

// One PR with its items, budget effect, decision, PO, receiving and the ACCOUNTA bills linked to it — and the actions
// each person may take at the current step.
export default function PrDetailModal({ id, me, onClose, onChanged, onEdit }: {
  id: number; me: Overview["me"]; onClose: () => void; onChanged: () => Promise<void> | void; onEdit: (id: number) => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState(false);
  const [rejecting, setRejecting] = useState(false); const [note, setNote] = useState("");
  const [po, setPo] = useState({ vendor: "", date: "", note: "" }); const [recvNote, setRecvNote] = useState("");
  const [picked, setPicked] = useState<number[]>([]);

  const load = useCallback(async () => {
    const r = await api<Detail>(apiUrl(`${URL_}?id=${id}`));
    if (!r.ok) { setErr(r.j.message ?? "โหลดไม่สำเร็จ"); return; }
    setErr(null); setD(r.j); setPo((p) => ({ ...p, vendor: p.vendor || r.j.pr.vendorName }));
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function act(body: Record<string, unknown>, after?: () => void) {
    setBusy(true); setErr(null);
    try {
      const r = await api(apiUrl(URL_), { method: "POST", body: { id, ...body } });
      if (!r.ok) { setErr(r.j.message ?? "ทำรายการไม่สำเร็จ"); return false; }
      after?.(); await load(); await onChanged(); return true;
    } finally { setBusy(false); }
  }

  if (!d) return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}><div className="bg-white rounded-2xl p-6 text-sm text-slate-500">{err ?? "กำลังโหลด…"}</div></div>;
  const { pr, items, bills, linkable, impact } = d; const poRow = d.po;
  const canAct = me.isApprover || me.adminBranchIds.includes(pr.branchId);
  const st = pr.status;

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/50 p-3 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full my-4" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 pt-5 pb-3 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-slate-400">{pr.prNo}{poRow ? ` · ${poRow.poNo}` : ""} · {pr.branchName}</div>
            <div className="text-lg font-bold text-slate-800">{pr.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className={`tag ${STATUS[st].cls}`}>{STATUS[st].label}</span>
              <span className={`tag ${pr.kind === "capex" ? "tag-info" : "tag-mute"}`}>{KIND_LABEL[pr.kind]}</span>
              <span className="text-xs text-slate-500">{pr.category}</span>
              {pr.overBudget && <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-bold">เกินงบ</span>}
            </div>
          </div>
          <button type="button" className="text-slate-400 hover:text-slate-600 text-xl leading-none" onClick={onClose} aria-label="ปิด">×</button>
        </div>

        <div className="px-6 py-4 space-y-4 text-sm">
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-slate-600">
            <div>ผู้ขอ: <b className="text-slate-800">{pr.requestedByName}</b></div>
            <div>ต้องการภายใน: <b className="text-slate-800">{pr.neededDate ?? "—"}</b></div>
            <div>ผู้ขาย: <b className="text-slate-800">{pr.vendorName || "—"}</b></div>
            <div>ส่งอนุมัติเมื่อ: <b className="text-slate-800">{pr.submittedAt ?? "—"}</b></div>
            {pr.reason && <div className="sm:col-span-2">เหตุผล: <span className="text-slate-800">{pr.reason}</span></div>}
            {pr.overBudgetReason && <div className="sm:col-span-2 text-rose-700">เหตุผลขอเกินงบ: {pr.overBudgetReason}</div>}
          </div>

          <table className="w-full">
            <thead><tr className="text-left text-xs text-slate-500 border-b"><th className="py-1">#</th><th>รายการ</th><th className="text-right">จำนวน</th><th className="text-right">ราคา/หน่วย</th><th className="text-right">รวม</th></tr></thead>
            <tbody>{items.map((i) => <tr key={i.lineNo} className="border-b border-slate-100 last:border-0"><td className="py-1 text-slate-400">{i.lineNo}</td><td>{i.description}</td><td className="text-right tabular-nums">{i.qty}{i.unit ? ` ${i.unit}` : ""}</td><td className="text-right tabular-nums">{fmtMoney(i.unitPrice)}</td><td className="text-right tabular-nums">{fmtMoney(i.amount)}</td></tr>)}</tbody>
            <tfoot className="text-right text-slate-600">
              <tr><td colSpan={4} className="pt-2">ก่อน VAT</td><td className="pt-2 tabular-nums">{fmtMoney(pr.subtotal)}</td></tr>
              {pr.vatRate > 0 && <tr><td colSpan={4}>VAT {pr.vatRate}%</td><td className="tabular-nums">{fmtMoney(pr.vatAmount)}</td></tr>}
              <tr className="font-bold text-slate-800"><td colSpan={4}>รวมทั้งสิ้น</td><td className="tabular-nums">฿{fmtMoney(pr.total)}</td></tr>
            </tfoot>
          </table>

          <div className={`rounded-xl border px-4 py-3 ${impact.over ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-slate-50"}`}>
            <div className="font-semibold text-slate-700">ผลต่องบ {pr.category} ({KIND_LABEL[pr.kind]})</div>
            <div className="text-slate-600 mt-0.5">งบ ฿{fmtMoney(impact.usage.budget)} · ใช้จริง ฿{fmtMoney(impact.usage.actual)} · ผูกพัน (รวมใบนี้ถ้าอยู่ระหว่างดำเนินการ) ฿{fmtMoney(impact.usage.committed)}</div>
            <div className={`font-semibold ${impact.over ? "text-rose-700" : "text-emerald-700"}`}>คงเหลือหลังใบนี้ ฿{fmtMoney(impact.afterRemaining)}{impact.over ? " (เกินงบ)" : ""}</div>
          </div>

          {pr.decidedAt && (
            <div className={`rounded-xl px-4 py-2 ${st === "rejected" ? "bg-rose-50 text-rose-800" : "bg-emerald-50 text-emerald-800"}`}>
              {st === "rejected" ? "ไม่อนุมัติ" : "อนุมัติ"}โดย {pr.decidedByName} · {pr.decidedAt}{pr.decisionNote ? ` — ${pr.decisionNote}` : ""}
            </div>
          )}

          {poRow && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-slate-700">
              <div className="font-semibold text-blue-800">ใบสั่งซื้อ {poRow.poNo}</div>
              <div>ผู้ขาย {poRow.vendorName} · ยอด ฿{fmtMoney(poRow.total)} · ออกเมื่อ {poRow.issuedAt}{poRow.expectedDate ? ` · กำหนดส่ง ${poRow.expectedDate}` : ""}</div>
              {poRow.note && <div className="text-xs text-slate-500">{poRow.note}</div>}
              {poRow.receivedAt && <div className="text-emerald-700">รับของแล้ว {poRow.receivedAt}{poRow.receiveNote ? ` — ${poRow.receiveNote}` : ""}</div>}
            </div>
          )}

          {poRow && (
            <div>
              <div className="font-semibold text-slate-700 mb-1">บิลที่ผูก (ACCOUNTA)</div>
              {bills.length === 0 ? <div className="text-slate-400">ยังไม่ได้ผูกบิล — ผูกบิลแล้วยอดนี้จะเปลี่ยนจาก “ผูกพัน” เป็น “ใช้จริง”</div> : (
                <ul className="divide-y divide-slate-100">
                  {bills.map((b) => (
                    <li key={b.expenseId} className="py-1 flex items-center gap-2"><span className="w-24 text-slate-500">{b.billDate}</span><span className="flex-1">{b.vendorName} {b.description}</span><span className="tabular-nums">{fmtMoney(b.amount)}</span>
                      {canAct && <button type="button" className="text-xs text-rose-500 hover:underline" disabled={busy} onClick={() => act({ action: "unlink_bill", expense_id: b.expenseId })}>เอาออก</button>}</li>
                  ))}
                  <li className="py-1 flex justify-between font-semibold"><span>รวมบิล</span><span className="tabular-nums">฿{fmtMoney(bills.reduce((s, b) => s + b.amount, 0))} <span className="text-xs font-normal text-slate-400">(PO ฿{fmtMoney(poRow.total)})</span></span></li>
                </ul>
              )}
              {canAct && linkable.length > 0 && (
                <div className="mt-2 rounded-xl border border-slate-200 p-3">
                  <div className="text-xs text-slate-500 mb-1">บิลที่ลงบัญชีแล้วของสาขา/หมวดนี้ที่ยังไม่ผูก — เลือกที่ตรงกับ PO นี้</div>
                  <ul className="max-h-40 overflow-y-auto">
                    {linkable.map((b) => (
                      <li key={b.expenseId}><label className="flex items-center gap-2 py-0.5 cursor-pointer"><input type="checkbox" checked={picked.includes(b.expenseId)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, b.expenseId] : p.filter((x) => x !== b.expenseId)))} />
                        <span className="w-24 text-slate-500">{b.billDate}</span><span className="flex-1 truncate">{b.vendorName} {b.description}</span><span className="tabular-nums">{fmtMoney(b.amount)}</span></label></li>
                    ))}
                  </ul>
                  <button type="button" className="btn-secondary text-sm mt-2" disabled={busy || picked.length === 0} onClick={() => act({ action: "link_bills", expense_ids: picked }, () => setPicked([]))}>ผูกบิลที่เลือก ({picked.length})</button>
                </div>
              )}
            </div>
          )}

          {err && <div className="text-rose-600">{err}</div>}

          {/* actions for the current step */}
          <div className="border-t border-slate-100 pt-3 space-y-3">
            {st === "draft" && canAct && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => act({ action: "submit" })}>ส่งอนุมัติ</button>
                <button type="button" className="btn-secondary text-sm" onClick={() => onEdit(pr.id)}>แก้ไข</button>
                <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => window.confirm("ยกเลิกใบขอซื้อนี้?") && act({ action: "cancel" })}>ยกเลิก</button>
              </div>
            )}
            {st === "submitted" && (
              <div className="space-y-2">
                {me.isApprover && !rejecting && (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn-success text-sm" disabled={busy} onClick={() => setPin(true)}>อนุมัติ (ใส่ PIN)</button>
                    <button type="button" className="btn-danger text-sm" disabled={busy} onClick={() => setRejecting(true)}>ไม่อนุมัติ</button>
                  </div>
                )}
                {rejecting && (
                  <div className="space-y-2">
                    <textarea className="input" rows={2} placeholder="เหตุผลที่ไม่อนุมัติ (จำเป็น)" value={note} onChange={(e) => setNote(e.target.value)} />
                    <div className="flex gap-2"><button type="button" className="btn-danger text-sm" disabled={busy || !note.trim()} onClick={() => act({ action: "decide", approve: false, note }, () => setRejecting(false))}>ยืนยันไม่อนุมัติ</button><button type="button" className="btn-secondary text-sm" onClick={() => setRejecting(false)}>กลับ</button></div>
                  </div>
                )}
                {canAct && <button type="button" className="text-sm text-slate-500 hover:underline" disabled={busy} onClick={() => window.confirm("ยกเลิกใบขอซื้อนี้?") && act({ action: "cancel" })}>ยกเลิกใบขอซื้อ</button>}
                {!me.isApprover && <div className="text-slate-500">รอผู้บริหารพิจารณา</div>}
              </div>
            )}
            {st === "rejected" && canAct && (
              <div className="flex gap-2"><button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => act({ action: "reopen" })}>เปิดแก้ไขใหม่</button><button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => window.confirm("ยกเลิกใบขอซื้อนี้?") && act({ action: "cancel" })}>ยกเลิก</button></div>
            )}
            {st === "approved" && canAct && (
              <div className="space-y-2">
                <div className="font-semibold text-slate-700">ออกใบสั่งซื้อ (PO)</div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <input className="input" placeholder="ชื่อผู้ขาย" value={po.vendor} onChange={(e) => setPo({ ...po, vendor: e.target.value })} />
                  <input type="date" className="input" value={po.date} onChange={(e) => setPo({ ...po, date: e.target.value })} />
                  <input className="input" placeholder="หมายเหตุ (ถ้ามี)" value={po.note} onChange={(e) => setPo({ ...po, note: e.target.value })} />
                </div>
                <div className="flex gap-2"><button type="button" className="btn-primary text-sm" disabled={busy || !po.vendor.trim()} onClick={() => act({ action: "issue_po", vendor_name: po.vendor, expected_date: po.date || null, note: po.note })}>ออก PO</button>
                  <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => window.confirm("ยกเลิกใบขอซื้อนี้?") && act({ action: "cancel" })}>ยกเลิก</button></div>
              </div>
            )}
            {st === "ordered" && canAct && (
              <div className="space-y-2">
                <input className="input" placeholder="หมายเหตุการรับของ (ถ้ามี)" value={recvNote} onChange={(e) => setRecvNote(e.target.value)} />
                <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => act({ action: "receive", note: recvNote })}>รับของแล้ว</button>
              </div>
            )}
            {st === "received" && <div className="text-slate-500">รับของแล้ว — ผูกบิลที่ลงบัญชีเพื่อปิดใบขอซื้อ</div>}
            {st === "closed" && <div className="text-emerald-700">ปิดแล้ว — ผูกบิลครบ ยอดนี้เป็นยอดใช้จริงใน ACCOUNTA</div>}
          </div>
        </div>
      </div>
      {pin && (
        <PinPromptModal title="อนุมัติใบขอซื้อ" description={<p className="text-xs text-slate-600">{pr.prNo} · {pr.title} · ฿{fmtMoney(pr.total)}{impact.over ? " · เกินงบ" : ""}</p>} submitLabel="อนุมัติ" onClose={() => setPin(false)}
          onSubmit={async (p) => {
            const r = await api(apiUrl(URL_), { method: "POST", body: { id, action: "decide", approve: true, pin: p } });
            if (!r.ok) return { ok: false as const, message: r.j.message ?? "อนุมัติไม่สำเร็จ" };
            setPin(false); await load(); await onChanged(); return { ok: true as const };
          }} />
      )}
    </div>
  );
}
