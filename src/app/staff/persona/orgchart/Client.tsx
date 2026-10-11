"use client";

import { useMemo, useState } from "react";
import { buildOrgForest, type OrgPlacementBase, type OrgTreeNode } from "@/lib/org-chart-tree";
import { departmentTone, DEPARTMENTS } from "@/lib/org-vocab";
import { nameWithPrefix } from "@/lib/name";

type Person = { userId: number; displayName: string; titlePrefix: string | null; nickname: string | null; jobTitle: string | null; department: string | null };
export type StaffChart = {
  branchId: number; branchName: string;
  placements: Array<Person & { nodeId: number; parentNodeIds: number[]; sortOrder: number; role: string }>;
  onChart: boolean; bosses: Person[]; reports: Person[];
};

const nameOf = (p: Person) => {
  const base = nameWithPrefix(p.titlePrefix, p.displayName);
  return p.nickname?.trim() ? `${base} (${p.nickname.trim()})` : base;
};
const deptTone = (label: string) => { const k = DEPARTMENTS.find((d) => d.labelTh === label); return k ? departmentTone(k.key) : "bg-slate-100 text-slate-700 border-slate-200"; };

export default function Client({ meId, charts, initialBranchId }: { meId: number; charts: StaffChart[]; initialBranchId: number | null }) {
  const [branchId, setBranchId] = useState<number | null>(initialBranchId);
  const chart = charts.find((c) => c.branchId === branchId) ?? null;
  if (!chart) return <div className="card text-sm text-slate-600">ท่านยังไม่ได้สังกัดสาขาใด จึงยังไม่มีผังองค์กรให้แสดง</div>;

  const bossIds = new Set(chart.bosses.map((b) => b.userId));
  const reportIds = new Set(chart.reports.map((r) => r.userId));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-900">ผังองค์กร</h1>
        <p className="text-sm text-slate-500 mt-0.5">ดูว่าท่านอยู่สายงานของใคร รายงานต่อใคร และดูแลใครบ้าง</p>
      </div>

      {charts.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {charts.map((c) => (
            <button key={c.branchId} type="button" onClick={() => setBranchId(c.branchId)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${c.branchId === branchId ? "bg-brand text-white" : "bg-slate-100 text-slate-600"}`}>{c.branchName}</button>
          ))}
        </div>
      )}

      <section className="card space-y-3">
        <h2 className="font-semibold text-slate-800">สายงานของท่าน · {chart.branchName}</h2>
        {!chart.onChart ? (
          <p className="text-sm text-slate-500">ท่านยังไม่ปรากฏในผังของสาขานี้ กรุณาแจ้งฝ่ายบุคคลให้ตรวจสอบข้อมูลสาขาของท่าน</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-xs font-semibold text-amber-800 mb-1">ท่านรายงานต่อ</div>
              {chart.bosses.length === 0
                ? <p className="text-sm text-slate-500">ยังไม่ได้ระบุผู้บังคับบัญชา หากท่านเป็นผู้บริหารถือเป็นตำแหน่งสูงสุดของสาย</p>
                : <ul className="space-y-1">{chart.bosses.map((b) => <PersonRow key={b.userId} p={b} tone="boss" />)}</ul>}
            </div>
            <div>
              <div className="text-xs font-semibold text-emerald-800 mb-1">ท่านดูแล</div>
              {chart.reports.length === 0
                ? <p className="text-sm text-slate-500">ท่านไม่มีผู้ใต้บังคับบัญชาโดยตรง</p>
                : <ul className="space-y-1">{chart.reports.map((r) => <PersonRow key={r.userId} p={r} tone="report" />)}</ul>}
            </div>
          </div>
        )}
      </section>

      <section className="card space-y-2">
        <h2 className="font-semibold text-slate-800">ผังทั้งสาขา</h2>
        {chart.placements.length === 0 ? <p className="text-sm text-slate-500">สาขานี้ยังไม่มีผังองค์กร</p> : <Tree placements={chart.placements} meId={meId} bossIds={bossIds} reportIds={reportIds} />}
        <p className="text-xs text-slate-500">กรอบสีทองเข้มคือท่าน กรอบสีทองอ่อนคือผู้ที่ท่านรายงานต่อ กรอบสีเขียวคือผู้ที่ท่านดูแล ป้ายสีแสดงฝ่าย</p>
      </section>
    </div>
  );
}

function PersonRow({ p, tone }: { p: Person; tone: "boss" | "report" }) {
  return (
    <li className={`rounded-lg border px-3 py-2 text-sm ${tone === "boss" ? "border-amber-300 bg-amber-50" : "border-emerald-300 bg-emerald-50"}`}>
      <div className="font-medium text-slate-900">{nameOf(p)}</div>
      <div className="text-xs text-slate-600">{[p.jobTitle, p.department].filter(Boolean).join(" · ")}</div>
    </li>
  );
}

function Tree({ placements, meId, bossIds, reportIds }: { placements: StaffChart["placements"]; meId: number; bossIds: Set<number>; reportIds: Set<number> }) {
  const roots = useMemo(() => buildOrgForest(placements as OrgPlacementBase[]), [placements]);
  return (
    <div className="overflow-x-auto">
      <div className="orgtree inline-block min-w-full text-center">
        <ul>{roots.map((n) => <Node key={n.key} node={n} meId={meId} bossIds={bossIds} reportIds={reportIds} />)}</ul>
      </div>
      <style jsx global>{`
        .orgtree ul { display: flex; justify-content: center; padding-top: 18px; position: relative; margin: 0; list-style: none; padding-left: 0; }
        .orgtree > ul { padding-top: 0; }
        .orgtree li { list-style: none; position: relative; padding: 18px 8px 0; }
        .orgtree li::before, .orgtree li::after { content: ''; position: absolute; top: 0; right: 50%; border-top: 2px solid #cbd5e1; width: 50%; height: 18px; }
        .orgtree li::after { right: auto; left: 50%; border-left: 2px solid #cbd5e1; }
        .orgtree li::before { border-right: 2px solid #cbd5e1; }
        .orgtree li:only-child::after, .orgtree li:only-child::before { display: none; }
        .orgtree li:only-child { padding-top: 0; }
        .orgtree li:first-child::before, .orgtree li:last-child::after { border: 0 none; }
        .orgtree li:last-child::before { border-right: 2px solid #cbd5e1; border-radius: 0 6px 0 0; }
        .orgtree li:first-child::after { border-radius: 6px 0 0 0; }
        .orgtree ul ul::before { content: ''; position: absolute; top: 0; left: 50%; border-left: 2px solid #cbd5e1; width: 0; height: 18px; }
      `}</style>
    </div>
  );
}

function Node({ node, meId, bossIds, reportIds }: { node: OrgTreeNode; meId: number; bossIds: Set<number>; reportIds: Set<number> }) {
  const me = node.userId === meId;
  const ring = me ? "border-amber-700 bg-amber-100 ring-2 ring-amber-600" : bossIds.has(node.userId) ? "border-amber-300 bg-amber-50" : reportIds.has(node.userId) ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white";
  return (
    <li>
      <div className={`inline-block align-top rounded-xl border px-3 py-2 shadow-sm text-left ${ring}`}>
        <div className="font-semibold text-slate-800 text-sm whitespace-nowrap">{nameOf(node)}{me ? " (ท่าน)" : ""}</div>
        {node.jobTitle && <div className="text-[11px] text-slate-500 whitespace-nowrap">{node.jobTitle}</div>}
        {node.department && <span className={`inline-block mt-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${deptTone(node.department)}`}>{node.department}</span>}
      </div>
      {node.children.length > 0 && <ul>{node.children.map((c) => <Node key={c.key} node={c} meId={meId} bossIds={bossIds} reportIds={reportIds} />)}</ul>}
    </li>
  );
}
