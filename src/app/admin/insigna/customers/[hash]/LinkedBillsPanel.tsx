"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";
import type { LinkedBill, CustomerBillStats } from "@/lib/insigna";

// INSIGNA CRM Phase 1 (owner 2026-09-24): staff link POS bills to this
// customer, and the panel rolls the linked receipts into a per-person
// snapshot (spend, cadence, favourite items, usual hour).

const money = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function LinkedBillsPanel({
  hash, branchId, branchName, initialBills, initialStats, today
}: {
  hash: string;
  branchId: number | null;
  branchName: string | null;
  initialBills: LinkedBill[];
  initialStats: CustomerBillStats;
  today: string;
}) {
  const [bills, setBills] = useState(initialBills);
  const [stats, setStats] = useState(initialStats);
  const [billNo, setBillNo] = useState("");
  const [date, setDate] = useState(today);
  const [receiptId, setReceiptId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function call(body: Record<string, unknown>) {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/insigna/customers/${hash}/bills`), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (j.bills) setBills(j.bills);
      if (j.stats) setStats(j.stats);
      return j.result as string | undefined;
    } catch { return undefined; }
    finally { setBusy(false); }
  }

  async function link() {
    if (!billNo.trim() || branchId == null) return;
    const r = await call({ action: "link", branch_id: branchId, sale_date: date, bill_no: billNo.trim() });
    if (r === "linked" || r === "already_yours") { setBillNo(""); setMsg({ kind: "ok", text: r === "linked" ? "ผูกบิลแล้ว ✓" : "บิลนี้ผูกไว้แล้ว" }); }
    else if (r === "receipt_not_found") setMsg({ kind: "err", text: "ไม่พบบิลนี้ (นำเข้าไฟล์ยอดขายของวันนั้นหรือยังคะ)" });
    else if (r === "linked_to_other") setMsg({ kind: "err", text: "บิลนี้ผูกกับลูกค้าท่านอื่นแล้ว" });
    else setMsg({ kind: "err", text: "ผูกไม่สำเร็จ" });
  }

  async function linkById() {
    const id = receiptId.trim();
    if (!id) return;
    const r = await call({ action: "link_by_id", receipt_id: id });
    if (r === "linked" || r === "already_yours") { setReceiptId(""); setMsg({ kind: "ok", text: r === "linked" ? "ผูกบิลแล้ว ✓" : "บิลนี้ผูกไว้แล้ว" }); }
    else if (r === "receipt_not_found") setMsg({ kind: "err", text: "ไม่พบรหัสบิลนี้ (นำเข้าไฟล์ใบเสร็จของวันนั้นหรือยังคะ)" });
    else if (r === "linked_to_other") setMsg({ kind: "err", text: "บิลนี้ผูกกับลูกค้าท่านอื่นแล้ว" });
    else setMsg({ kind: "err", text: "ผูกไม่สำเร็จ" });
  }

  async function unlink(b: LinkedBill) {
    const r = await call({ action: "unlink", branch_id: b.branch_id, sale_date: b.sale_date, bill_no: b.bill_no });
    setMsg(r === "unlinked"
      ? { kind: "ok", text: "ยกเลิกการผูกแล้ว" }
      : { kind: "err", text: "ยกเลิกไม่สำเร็จ ลองใหม่นะคะ" });
  }

  return (
    <div className="card">
      <h2 className="text-sm font-bold text-slate-700 mb-3">ประวัติการซื้อ (จากใบเสร็จที่ผูกไว้)</h2>

      {/* CRM snapshot */}
      {stats.billCount === 0 ? (
        <div className="text-xs text-slate-400 py-2">ยังไม่มีบิลที่ผูกกับลูกค้าท่านนี้ — กรอกเลขบิลด้านล่างเพื่อเริ่ม</div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          {[
            { label: "มาแล้ว", v: `${stats.distinctDays} วัน`, sub: `${stats.billCount} บิล` },
            { label: "ยอดซื้อรวม", v: `฿${money(stats.totalNett)}`, sub: stats.avgNett != null ? `เฉลี่ย ฿${money(stats.avgNett)}/บิล` : "" },
            { label: "เวลาที่ชอบมา", v: stats.peakHour != null ? `${String(stats.peakHour).padStart(2, "0")}:00` : "—", sub: "ช่วงที่มาบ่อยสุด" },
            { label: "มาล่าสุด", v: stats.lastVisit ?? "—", sub: stats.firstVisit ? `ครั้งแรก ${stats.firstVisit}` : "" }
          ].map((s) => (
            <div key={s.label} className="rounded-lg bg-slate-50 border border-slate-100 p-2.5">
              <div className="text-[10px] uppercase tracking-wide font-bold text-slate-500">{s.label}</div>
              <div className="text-lg font-bold text-slate-800 tabular-nums">{s.v}</div>
              {s.sub && <div className="text-[11px] text-slate-400">{s.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {stats.topItems.length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-semibold text-slate-600 mb-1">เมนูที่สั่งบ่อย</div>
          <div className="flex flex-wrap gap-1.5">
            {stats.topItems.map((it) => (
              <span key={it.name} className="text-[11px] px-2 py-0.5 rounded-full bg-brand/10 text-brand-dark">
                {it.name} ×{it.qty}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Link a bill */}
      <div className="border-t border-slate-100 pt-3">
        <div className="text-xs font-semibold text-slate-600 mb-1.5">
          ผูกบิลให้ลูกค้า {branchName ? <span className="text-slate-400">· สาขา {branchName}</span> : null}
        </div>
        {branchId == null ? (
          <div className="text-xs text-rose-500">เลือกสาขาที่มุมบนซ้ายก่อนค่ะ</div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="text-[11px] text-slate-500">วันที่</label>
              <input type="date" className="input !w-40" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="text-[11px] text-slate-500">เลขบิล (No.)</label>
              <input className="input !w-32" value={billNo} inputMode="numeric" placeholder="เช่น 1428"
                onChange={(e) => { setBillNo(e.target.value); setMsg(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") link(); }} />
            </div>
            <button type="button" onClick={link} disabled={busy || !billNo.trim()}
              className="btn-primary text-sm px-4 py-2 disabled:opacity-50">ผูกบิล</button>
          </div>
        )}
        {msg && <div className={`text-xs mt-1.5 ${msg.kind === "ok" ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</div>}
        <p className="text-[11px] text-slate-400 mt-1">ใช้เลขบิลจากไฟล์ยอดขายที่นำเข้า (สาขา+วันที่+เลขบิล) · ผูกได้เฉพาะบิลของสาขาที่เลือกอยู่</p>

        {/* Or link by FeedMe's long receipt id — no branch/date needed, it
            resolves the bill on its own (owner 2026-09-24). */}
        <div className="mt-3 pt-3 border-t border-dashed border-slate-100">
          <div className="text-xs font-semibold text-slate-600 mb-1.5">หรือวางรหัสบิลยาวจากใบเสร็จ (ID)</div>
          <div className="flex flex-wrap items-end gap-2">
            <input className="input !w-52 font-mono" value={receiptId} placeholder="เช่น 823Z_4w8g"
              onChange={(e) => { setReceiptId(e.target.value); setMsg(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") linkById(); }} />
            <button type="button" onClick={linkById} disabled={busy || !receiptId.trim()}
              className="btn-primary text-sm px-4 py-2 disabled:opacity-50">ผูกด้วยรหัส</button>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">รหัสจากช่อง ID บนใบเสร็จ FeedMe · ระบบจะหาสาขาและวันที่ให้เอง</p>
        </div>
      </div>

      {/* Linked bills list */}
      {bills.length > 0 && (
        <div className="border-t border-slate-100 pt-3 mt-3 space-y-1">
          {bills.map((b) => (
            <div key={`${b.branch_id}-${b.sale_date}-${b.bill_no}`}
              className="flex items-center gap-2 text-xs py-1 border-b border-slate-50 last:border-b-0">
              <span className="font-mono text-slate-500 w-14">#{b.bill_no}</span>
              <span className="text-slate-500 w-24">{b.sale_date}</span>
              <span className="text-slate-400">{String(b.hour).padStart(2, "0")}:00</span>
              {b.table_name && <span className="text-slate-400">· {b.table_name}</span>}
              <span className="ml-auto font-bold text-slate-700 tabular-nums">฿{money(b.nett)}</span>
              <button type="button" onClick={() => unlink(b)} disabled={busy}
                className="text-slate-300 hover:text-rose-500 px-1" aria-label="ยกเลิกการผูก">×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
