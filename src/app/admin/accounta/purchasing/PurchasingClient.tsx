"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtMoney } from "@/lib/format";
import { apiUrl } from "@/lib/url";
import { api, KIND_LABEL, STATUS, type Kind, type Overview, type Pr, type Usage } from "./types";
import PrFormModal from "./PrFormModal";
import PrDetailModal from "./PrDetailModal";
import BudgetModal from "./BudgetModal";

type Tab = "pending" | "active" | "done" | "all";
const TABS: Array<{ key: Tab; label: string; match: (p: Pr) => boolean }> = [
  { key: "pending", label: "รออนุมัติ", match: (p) => p.status === "submitted" },
  { key: "active", label: "กำลังดำเนินการ", match: (p) => ["draft", "approved", "ordered", "received", "rejected"].includes(p.status) },
  { key: "done", label: "ปิดแล้ว/ยกเลิก", match: (p) => ["closed", "cancelled"].includes(p.status) },
  { key: "all", label: "ทั้งหมด", match: () => true }
];

function Bar({ used, budget }: { used: number; budget: number }) {
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : used > 0 ? 100 : 0;
  const over = used > budget;
  return <div className="h-1.5 w-24 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full ${over ? "bg-rose-500" : pct > 80 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} /></div>;
}

export default function PurchasingClient({ openPrId }: { openPrId: number | null }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("pending");
  const [branchFilter, setBranchFilter] = useState<number | "all">("all");
  const [form, setForm] = useState<{ edit: number | null } | null>(null);
  const [detailId, setDetailId] = useState<number | null>(openPrId);
  const [budgetOpen, setBudgetOpen] = useState(false);

  const load = useCallback(async () => {
    const r = await api<Overview>(apiUrl(`/api/admin/accounta/purchasing?year=${year}`));
    if (!r.ok) { setErr(r.j.message ?? "โหลดข้อมูลไม่สำเร็จ"); return; }
    setErr(null); setData(r.j);
  }, [year]);
  useEffect(() => { void load(); }, [load]);
  // land on the tab that has something to do the first time the data arrives
  useEffect(() => { if (data && !data.prs.some((p) => p.status === "submitted")) setTab((t) => (t === "pending" ? "active" : t)); }, [data?.year]); // eslint-disable-line react-hooks/exhaustive-deps

  const usage = useMemo(() => (data?.usage ?? []).filter((u) => branchFilter === "all" || u.branchId === branchFilter), [data, branchFilter]);
  const sums = useMemo(() => {
    const z = () => ({ budget: 0, actual: 0, committed: 0, remaining: 0 });
    const s: Record<Kind, ReturnType<typeof z>> = { opex: z(), capex: z() };
    for (const u of usage) { const t = s[u.kind]; t.budget += u.budget; t.actual += u.actual; t.committed += u.committed; t.remaining += u.remaining; }
    return s;
  }, [usage]);
  const prs = useMemo(() => (data?.prs ?? []).filter((p) => (branchFilter === "all" || p.branchId === branchFilter) && TABS.find((t) => t.key === tab)!.match(p)), [data, tab, branchFilter]);
  const pendingCount = (data?.prs ?? []).filter((p) => p.status === "submitted").length;
  const branchName = (id: number) => data?.branches.find((b) => b.id === id)?.name ?? `#${id}`;

  if (err) return <div className="card text-sm text-rose-600">{err}</div>;
  if (!data) return <div className="card text-sm text-slate-400">กำลังโหลด…</div>;

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-2">
        <button type="button" className="chip" onClick={() => setYear((y) => y - 1)}>◀</button>
        <div className="font-semibold text-slate-800 w-24 text-center">ปี {year + 543}</div>
        <button type="button" className="chip" onClick={() => setYear((y) => y + 1)}>▶</button>
        <select className="input !w-auto" value={branchFilter} onChange={(e) => setBranchFilter(e.target.value === "all" ? "all" : Number(e.target.value))}>
          <option value="all">ทุกสาขา</option>
          {data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <div className="flex-1" />
        {data.me.isApprover && <button type="button" className="btn-secondary text-sm" onClick={() => setBudgetOpen(true)}>ตั้ง/แก้งบประมาณ</button>}
        <button type="button" className="btn-primary text-sm" onClick={() => setForm({ edit: null })}>+ สร้างใบขอซื้อ (PR)</button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {(["opex", "capex"] as Kind[]).map((k) => {
          const t = sums[k];
          return (
            <div key={k} className="card">
              <div className="flex items-baseline justify-between">
                <div className="font-bold text-slate-800">{KIND_LABEL[k]} <span className="text-xs font-normal text-slate-400">{k === "opex" ? "ค่าใช้จ่ายดำเนินงาน" : "รายจ่ายลงทุน/ครุภัณฑ์"}</span></div>
                <span className={`text-sm font-bold tabular-nums ${t.remaining < 0 ? "text-rose-600" : "text-emerald-700"}`}>คงเหลือ ฿{fmtMoney(t.remaining)}</span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div><div className="text-[11px] text-slate-400">งบ</div><div className="font-semibold tabular-nums">{fmtMoney(t.budget)}</div></div>
                <div><div className="text-[11px] text-slate-400">ใช้จริง (บิล)</div><div className="font-semibold tabular-nums">{fmtMoney(t.actual)}</div></div>
                <div><div className="text-[11px] text-slate-400">ผูกพัน (PR/PO)</div><div className="font-semibold tabular-nums text-amber-700">{fmtMoney(t.committed)}</div></div>
              </div>
              <div className="mt-2"><Bar used={t.actual + t.committed} budget={t.budget} /></div>
            </div>
          );
        })}
      </div>

      <div className="card overflow-x-auto">
        <div className="font-semibold text-slate-700 mb-2">งบรายหมวด · เทียบยอดใช้จริงและยอดผูกพัน</div>
        {usage.length === 0 ? <div className="text-sm text-slate-400 py-4 text-center">ยังไม่ได้ตั้งงบปีนี้{data.me.isApprover ? " — กด “ตั้ง/แก้งบประมาณ”" : ""}</div> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-slate-500 border-b"><th className="py-1.5 pr-3">ประเภท</th><th className="pr-3">สาขา</th><th className="pr-3">หมวด</th><th className="pr-3 text-right">งบ</th><th className="pr-3 text-right">ใช้จริง</th><th className="pr-3 text-right">ผูกพัน</th><th className="pr-3 text-right">คงเหลือ</th><th></th></tr></thead>
            <tbody>
              {usage.map((u: Usage) => (
                <tr key={`${u.branchId}|${u.category}`} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 pr-3"><span className={`tag ${u.kind === "capex" ? "tag-info" : "tag-mute"}`}>{KIND_LABEL[u.kind]}</span></td>
                  <td className="pr-3 whitespace-nowrap">{branchName(u.branchId)}</td>
                  <td className="pr-3">{u.category}</td>
                  <td className="pr-3 text-right tabular-nums">{u.budget ? fmtMoney(u.budget) : <span className="text-slate-300">ไม่ได้ตั้ง</span>}</td>
                  <td className="pr-3 text-right tabular-nums">{fmtMoney(u.actual)}</td>
                  <td className="pr-3 text-right tabular-nums text-amber-700">{u.committed ? fmtMoney(u.committed) : "—"}</td>
                  <td className={`pr-3 text-right tabular-nums font-semibold ${u.remaining < 0 ? "text-rose-600" : "text-emerald-700"}`}>{fmtMoney(u.remaining)}</td>
                  <td><Bar used={u.actual + u.committed} budget={u.budget} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="font-semibold text-slate-700 mr-2">ใบขอซื้อ (PR) / ใบสั่งซื้อ (PO)</div>
          {TABS.map((t) => (
            <button key={t.key} type="button" aria-pressed={tab === t.key} className={`chip ${tab === t.key ? "chip-active" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}{t.key === "pending" && pendingCount > 0 && <span className="chip-count ml-1">{pendingCount}</span>}
            </button>
          ))}
        </div>
        {prs.length === 0 ? <div className="text-sm text-slate-400 py-6 text-center">ไม่มีรายการ</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500 border-b"><th className="py-1.5 pr-3">เลขที่</th><th className="pr-3">เรื่อง</th><th className="pr-3">สาขา</th><th className="pr-3">ประเภท/หมวด</th><th className="pr-3 text-right">ยอดรวม</th><th className="pr-3">ผู้ขอ</th><th>สถานะ</th></tr></thead>
              <tbody>
                {prs.map((p) => (
                  <tr key={p.id} onClick={() => setDetailId(p.id)} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer">
                    <td className="py-2 pr-3 whitespace-nowrap font-medium text-brand">{p.prNo}{p.poNo && <span className="block text-[11px] text-slate-400">{p.poNo}</span>}</td>
                    <td className="pr-3">{p.title}{p.overBudget && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-bold">เกินงบ</span>}</td>
                    <td className="pr-3 whitespace-nowrap">{p.branchName}</td>
                    <td className="pr-3 text-xs"><span className={`tag ${p.kind === "capex" ? "tag-info" : "tag-mute"} mr-1`}>{KIND_LABEL[p.kind]}</span>{p.category}</td>
                    <td className="pr-3 text-right tabular-nums">{fmtMoney(p.total)}</td>
                    <td className="pr-3 whitespace-nowrap">{p.requestedByName}</td>
                    <td><span className={`tag ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {form && <PrFormModal data={data} editId={form.edit} defaultBranch={branchFilter === "all" ? (data.me.adminBranchIds[0] ?? data.branches[0]?.id) : branchFilter}
        onClose={() => setForm(null)} onSaved={async (id) => { setForm(null); await load(); setDetailId(id); }} />}
      {detailId != null && <PrDetailModal id={detailId} me={data.me} onClose={() => setDetailId(null)} onChanged={load} onEdit={(id) => { setDetailId(null); setForm({ edit: id }); }} />}
      {budgetOpen && <BudgetModal data={data} onClose={() => setBudgetOpen(false)} onSaved={async () => { setBudgetOpen(false); await load(); }} />}
    </div>
  );
}
