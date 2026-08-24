"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";
import { buildOrgForest, descendantsOf, type OrgTreeNode } from "@/lib/org-chart-tree";

export type OrgPlacementLite = {
  nodeId: number; userId: number; displayName: string; titlePrefix: string | null; nickname: string | null;
  jobTitle: string | null; role: string; department: string | null; sortOrder: number; parentNodeIds: number[];
};
export type OrgBranchData = {
  id: number; name: string;
  placements: OrgPlacementLite[];
  candidates: Array<{ userId: number; displayName: string; titlePrefix: string | null; nickname: string | null; jobTitle: string | null }>;
  departments: string[];
};

const DEPT_COLORS = [
  "bg-sky-100 text-sky-800 border-sky-200", "bg-emerald-100 text-emerald-800 border-emerald-200",
  "bg-violet-100 text-violet-800 border-violet-200", "bg-amber-100 text-amber-800 border-amber-200",
  "bg-rose-100 text-rose-800 border-rose-200", "bg-teal-100 text-teal-800 border-teal-200"
];
function deptColor(dep: string): string {
  let h = 0;
  for (let i = 0; i < dep.length; i++) h = (h * 31 + dep.charCodeAt(i)) >>> 0;
  return DEPT_COLORS[h % DEPT_COLORS.length];
}
function personName(m: { titlePrefix: string | null; displayName: string; nickname: string | null }): string {
  const base = nameWithPrefix(m.titlePrefix, m.displayName);
  return m.nickname?.trim() ? `${base} (${m.nickname.trim()})` : base;
}

export default function OrgChartClient({
  companyName, activeBranchId, branches
}: { companyName: string | null; activeBranchId: number; branches: OrgBranchData[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const multiBranch = branches.length > 1;
  const [tab, setTab] = useState<string>(multiBranch ? "company" : String(branches[0]?.id ?? activeBranchId));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ branchId: number; nodeId: number } | null>(null);
  const [nonce, setNonce] = useState(0);
  // Add-member form (per branch).
  const [addFor, setAddFor] = useState<number | null>(null);
  const [addUser, setAddUser] = useState<string>("");
  const [addParent, setAddParent] = useState<string>("");

  const errMap: Record<string, string> = {
    self: "ตั้งตัวเองเป็นหัวหน้าตัวเองไม่ได้",
    cycle: "ตั้งไม่ได้ — จะเกิดวงจร (กล่องนี้เป็นหัวหน้าของสายที่อยู่ใต้เขาอยู่แล้ว)",
    manager_not_on_chart: "หัวหน้าที่เลือกไม่อยู่ในผังสาขานี้",
    not_on_chart: "กล่องนี้ไม่อยู่ในผัง",
    not_addable: "เพิ่มไม่ได้ — พนักงานไม่ได้สังกัดสาขานี้ หรือหัวหน้าที่เลือกไม่ถูกต้อง",
    forbidden_branch: "ไม่มีสิทธิ์แก้สาขานี้",
    invalid_body: "ข้อมูลไม่ถูกต้อง"
  };

  async function post(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/orgchart"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(errMap[j.error] ?? "บันทึกไม่สำเร็จ"); setNonce((n) => n + 1); return false; }
      startTransition(() => router.refresh());
      return true;
    } catch { setErr("เชื่อมต่อไม่สำเร็จ"); return false; }
    finally { setBusy(false); }
  }

  const editBranch = editing ? branches.find((b) => b.id === editing.branchId) ?? null : null;
  const editNode = editBranch?.placements.find((p) => p.nodeId === editing?.nodeId) ?? null;
  const nodeName = (branch: OrgBranchData, nodeId: number) => {
    const p = branch.placements.find((x) => x.nodeId === nodeId);
    return p ? personName(p) : "—";
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ผังองค์กร</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          {companyName ? <b>{companyName}</b> : null} · โครงสร้างสายงานแยกตามสาขาและแผนก · แก้ไขได้ในหน้านี้
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {multiBranch && (
          <button type="button" onClick={() => setTab("company")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${tab === "company" ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
            ภาพรวมบริษัท
          </button>
        )}
        {branches.map((b) => (
          <button key={b.id} type="button" onClick={() => setTab(String(b.id))}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${tab === String(b.id) ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
            {b.name}
          </button>
        ))}
      </div>

      {err && <p className="text-sm text-rose-600">{err}</p>}

      {tab === "company" ? (
        <div className="space-y-4">
          {branches.map((b) => (
            <div key={b.id} className="card">
              <h2 className="font-bold text-slate-800 mb-2">{b.name}</h2>
              {b.placements.length === 0
                ? <p className="text-sm text-slate-400">— ยังไม่มีผังของสาขานี้ —</p>
                : <BranchTree branch={b} editable={false} onEdit={() => {}} />}
            </div>
          ))}
        </div>
      ) : (
        branches.filter((b) => String(b.id) === tab).map((b) => {
          return (
            <div key={b.id} className="card space-y-3">
              {/* Add placement — pick person + who they're under */}
              {addFor === b.id ? (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block">
                    <span className="text-[11px] text-slate-500">พนักงาน</span>
                    <select className="input !w-auto" value={addUser} onChange={(e) => setAddUser(e.target.value)}>
                      <option value="">— เลือกพนักงาน —</option>
                      {b.candidates.map((c) => (
                        <option key={c.userId} value={c.userId}>{personName(c)}{c.jobTitle ? ` · ${c.jobTitle}` : ""}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-slate-500">อยู่ใต้ (หัวหน้า)</span>
                    <select className="input !w-auto" value={addParent} onChange={(e) => setAddParent(e.target.value)}>
                      <option value="">— บนสุด (ไม่มีหัวหน้า) —</option>
                      {b.placements.map((p) => (
                        <option key={p.nodeId} value={p.nodeId}>
                          {personName(p)}{p.department ? ` · ${p.department}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" disabled={busy || !addUser}
                    onClick={async () => {
                      if (await post({ action: "add", branchId: b.id, userId: Number(addUser), parentNodeId: addParent ? Number(addParent) : null })) {
                        setAddUser(""); setAddParent(""); setAddFor(null);
                      }
                    }}
                    className="btn-primary disabled:opacity-50">เพิ่ม</button>
                  <button type="button" onClick={() => { setAddFor(null); setAddUser(""); setAddParent(""); }} className="btn-secondary">ยกเลิก</button>
                </div>
              ) : (
                <button type="button" onClick={() => { setAddFor(b.id); setErr(null); }} disabled={busy || b.candidates.length === 0}
                  className="btn-secondary disabled:opacity-50">+ เพิ่มคนเข้าผัง</button>
              )}

              {b.placements.length === 0 ? (
                <p className="text-sm text-slate-400 py-8 text-center">ยังไม่มีใครในผังของสาขานี้ — กด “เพิ่มคนเข้าผัง”</p>
              ) : (
                <BranchTree branch={b} editable onEdit={(nodeId) => { setEditing({ branchId: b.id, nodeId }); setErr(null); }} />
              )}
            </div>
          );
        })
      )}

      <p className="text-xs text-slate-400">
        เส้นสาย = ใครดูแลใคร (หัวหน้าอยู่บน) · ป้ายสี = แผนก · คนเดียวเพิ่มได้หลายกล่อง และอยู่ใต้ได้หลายหัวหน้า
      </p>

      {/* Edit dialog */}
      {editing && editNode && editBranch && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setEditing(null); }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md my-8 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-slate-800">{personName(editNode)}</h3>
              <button type="button" onClick={() => setEditing(null)} disabled={busy}
                className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
            </div>
            {editNode.jobTitle && <p className="text-xs text-slate-500 -mt-2">{editNode.jobTitle}</p>}

            <label className="block">
              <span className="text-xs text-slate-500">แผนก</span>
              <input key={`dept-${editNode.nodeId}-${nonce}`} className="input" list={`dept-${editBranch.id}`}
                defaultValue={editNode.department ?? ""} maxLength={60} placeholder="เช่น FOH, BOH, ครัว, บริการ"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (editNode.department ?? "")) post({ action: "department", branchId: editBranch.id, nodeId: editNode.nodeId, department: v || null });
                }} />
              <datalist id={`dept-${editBranch.id}`}>
                {editBranch.departments.map((d) => <option key={d} value={d} />)}
              </datalist>
            </label>

            {/* Managers (parents) — supports more than one */}
            <div>
              <span className="text-xs text-slate-500">หัวหน้า (อยู่ใต้) — เพิ่มได้มากกว่าหนึ่งคน</span>
              <div className="mt-1 space-y-1">
                {editNode.parentNodeIds.filter((pid) => editBranch.placements.some((p) => p.nodeId === pid)).length === 0 && (
                  <div className="text-[12px] text-slate-400">— อยู่บนสุด (ยังไม่มีหัวหน้า) —</div>
                )}
                {editNode.parentNodeIds.filter((pid) => editBranch.placements.some((p) => p.nodeId === pid)).map((pid) => (
                  <div key={pid} className="flex items-center justify-between rounded-lg bg-slate-50 border border-slate-200 px-2.5 py-1">
                    <span className="text-sm text-slate-700">{nodeName(editBranch, pid)}</span>
                    <button type="button" disabled={busy}
                      onClick={() => post({ action: "remove-parent", branchId: editBranch.id, nodeId: editNode.nodeId, parentNodeId: pid })}
                      className="text-xs text-rose-500 hover:text-rose-700 disabled:opacity-50">เอาออก</button>
                  </div>
                ))}
              </div>
              <select key={`addmgr-${editNode.nodeId}-${nonce}`} className="input mt-2" defaultValue="" disabled={busy}
                onChange={(e) => { const v = e.target.value; if (v) post({ action: "add-parent", branchId: editBranch.id, nodeId: editNode.nodeId, parentNodeId: Number(v) }); }}>
                <option value="">+ เพิ่มหัวหน้า…</option>
                {(() => {
                  const exclude = descendantsOf(editBranch.placements, editNode.nodeId);
                  const current = new Set(editNode.parentNodeIds);
                  return editBranch.placements
                    .filter((p) => p.nodeId !== editNode.nodeId && !exclude.has(p.nodeId) && !current.has(p.nodeId))
                    .map((p) => <option key={p.nodeId} value={p.nodeId}>{personName(p)}{p.department ? ` · ${p.department}` : ""}</option>);
                })()}
              </select>
            </div>

            <div className="flex justify-between items-center pt-1">
              <button type="button" disabled={busy}
                onClick={async () => { if (await post({ action: "remove", branchId: editBranch.id, nodeId: editNode.nodeId })) setEditing(null); }}
                className="text-sm text-rose-600 hover:underline disabled:opacity-50">ลบกล่องนี้ออกจากผัง</button>
              <button type="button" onClick={() => setEditing(null)} disabled={busy}
                className="btn-secondary disabled:opacity-50">เสร็จ</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BranchTree({ branch, editable, onEdit }: {
  branch: OrgBranchData; editable: boolean; onEdit: (nodeId: number) => void;
}) {
  const roots = useMemo(() => buildOrgForest(branch.placements), [branch.placements]);
  if (roots.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <div className="orgtree inline-block min-w-full text-center">
        <ul>
          {roots.map((n) => <OrgNode key={n.key} node={n} editable={editable} onEdit={onEdit} />)}
        </ul>
      </div>
      <style jsx global>{`
        .orgtree ul { display: flex; justify-content: center; padding-top: 18px; position: relative; margin: 0; list-style: none; padding-left: 0; }
        .orgtree > ul { padding-top: 0; }
        .orgtree li { list-style: none; position: relative; padding: 18px 10px 0; }
        .orgtree li::before, .orgtree li::after {
          content: ''; position: absolute; top: 0; right: 50%;
          border-top: 2px solid #cbd5e1; width: 50%; height: 18px;
        }
        .orgtree li::after { right: auto; left: 50%; border-left: 2px solid #cbd5e1; }
        .orgtree li::before { border-right: 2px solid #cbd5e1; }
        .orgtree li:only-child::after, .orgtree li:only-child::before { display: none; }
        .orgtree li:only-child { padding-top: 0; }
        .orgtree li:first-child::before, .orgtree li:last-child::after { border: 0 none; }
        .orgtree li:last-child::before { border-right: 2px solid #cbd5e1; border-radius: 0 6px 0 0; }
        .orgtree li:first-child::after { border-radius: 6px 0 0 0; }
        .orgtree ul ul::before {
          content: ''; position: absolute; top: 0; left: 50%;
          border-left: 2px solid #cbd5e1; width: 0; height: 18px;
        }
      `}</style>
    </div>
  );
}

function OrgNode({ node, editable, onEdit }: { node: OrgTreeNode; editable: boolean; onEdit: (nodeId: number) => void }) {
  const dual = node.mgrCount > 1;
  return (
    <li>
      <div className={`inline-block align-top rounded-xl border px-3 py-2 bg-white shadow-sm text-left border-slate-200 ${editable ? "cursor-pointer hover:border-brand" : ""}`}
        onClick={editable ? () => onEdit(node.nodeId) : undefined}
        role={editable ? "button" : undefined}>
        <div className="font-semibold text-slate-800 text-sm whitespace-nowrap">{personName(node)}</div>
        {node.jobTitle && <div className="text-[11px] text-slate-500 whitespace-nowrap">{node.jobTitle}</div>}
        <div className="flex items-center gap-1 mt-1">
          {node.department && (
            <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${deptColor(node.department)}`}>
              {node.department}
            </span>
          )}
          {dual && (
            <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-200"
              title="ขึ้นตรงกับหัวหน้าหลายคน">ขึ้นตรง {node.parentNodeIds.length}</span>
          )}
        </div>
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => <OrgNode key={c.key} node={c} editable={editable} onEdit={onEdit} />)}
        </ul>
      )}
    </li>
  );
}
