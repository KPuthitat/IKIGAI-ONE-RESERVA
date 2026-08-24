"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";

export type OrgMemberLite = {
  userId: number; displayName: string; titlePrefix: string | null; nickname: string | null;
  jobTitle: string | null; role: string; department: string | null;
  reportsToUserId: number | null; sortOrder: number;
};
export type OrgBranchData = {
  id: number; name: string;
  members: OrgMemberLite[];
  candidates: Array<{ userId: number; displayName: string; titlePrefix: string | null; nickname: string | null; jobTitle: string | null }>;
  departments: string[];
};

type TreeNode = OrgMemberLite & { children: TreeNode[] };

// Cycle-safe (mirrors src/lib/org-chart.ts buildOrgTree): a looping manager
// chain promotes the node to a root, so a bad edge can't infinite-loop render.
function buildTree(members: OrgMemberLite[]): TreeNode[] {
  const byId = new Map<number, TreeNode>();
  for (const m of members) byId.set(m.userId, { ...m, children: [] });
  const parentOf = (id: number): number | null => {
    const p = byId.get(id)?.reportsToUserId ?? null;
    return p != null && p !== id && byId.has(p) ? p : null;
  };
  const inCycle = (id: number): boolean => {
    const seen = new Set<number>();
    let cur: number | null = id;
    while (cur != null) { if (seen.has(cur)) return true; seen.add(cur); cur = parentOf(cur); }
    return false;
  };
  const roots: TreeNode[] = [];
  for (const n of byId.values()) {
    const p = parentOf(n.userId);
    if (p == null || inCycle(n.userId)) roots.push(n);
    else byId.get(p)!.children.push(n);
  }
  const sortRec = (ns: TreeNode[]) => {
    ns.sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
    ns.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

// Stable colour per department label.
const DEPT_COLORS = [
  "bg-sky-100 text-sky-800 border-sky-200",
  "bg-emerald-100 text-emerald-800 border-emerald-200",
  "bg-violet-100 text-violet-800 border-violet-200",
  "bg-amber-100 text-amber-800 border-amber-200",
  "bg-rose-100 text-rose-800 border-rose-200",
  "bg-teal-100 text-teal-800 border-teal-200"
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
  const [editing, setEditing] = useState<{ branchId: number; userId: number } | null>(null);
  const [addFor, setAddFor] = useState<number | null>(null);
  const [addSel, setAddSel] = useState<string>("");
  // Bumped when a save is rejected → remounts the edit controls so the
  // uncontrolled inputs revert to the (unchanged) saved server value.
  const [nonce, setNonce] = useState(0);

  async function post(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/orgchart"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        const map: Record<string, string> = {
          cycle: "ตั้งไม่ได้ — จะเกิดวงจร (คนนี้เป็นหัวหน้าของสายที่อยู่ใต้เขาอยู่แล้ว)",
          manager_not_on_chart: "หัวหน้าที่เลือกยังไม่อยู่ในผัง",
          not_on_chart: "คนนี้ยังไม่อยู่ในผัง",
          not_branch_member: "พนักงานคนนี้ไม่ได้สังกัดสาขานี้ (หรือไม่ใช่พนักงานที่ใช้งานอยู่)",
          forbidden_branch: "ไม่มีสิทธิ์แก้สาขานี้",
          invalid_body: "ข้อมูลไม่ถูกต้อง"
        };
        setErr(map[j.error] ?? "บันทึกไม่สำเร็จ");
        setNonce((n) => n + 1);   // revert the uncontrolled edit controls
        return false;
      }
      startTransition(() => router.refresh());
      return true;
    } catch {
      setErr("เชื่อมต่อไม่สำเร็จ");
      return false;
    } finally { setBusy(false); }
  }

  const editBranch = editing ? branches.find((b) => b.id === editing.branchId) ?? null : null;
  const editMember = editBranch?.members.find((m) => m.userId === editing?.userId) ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ผังองค์กร</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          {companyName ? <b>{companyName}</b> : null} · โครงสร้างสายงานแยกตามสาขาและแผนก · แก้ไขได้ในหน้านี้
        </p>
      </div>

      {/* Tabs */}
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
              {b.members.length === 0 ? (
                <p className="text-sm text-slate-400">— ยังไม่มีผังของสาขานี้ —</p>
              ) : (
                <BranchTree branch={b} editable={false} onEdit={() => {}} />
              )}
            </div>
          ))}
        </div>
      ) : (
        branches.filter((b) => String(b.id) === tab).map((b) => (
          <div key={b.id} className="card space-y-3">
            {/* Add member */}
            <div className="flex flex-wrap items-center gap-2">
              {addFor === b.id ? (
                <>
                  <select className="input !w-auto" value={addSel} onChange={(e) => setAddSel(e.target.value)}>
                    <option value="">— เลือกพนักงาน —</option>
                    {b.candidates.map((c) => (
                      <option key={c.userId} value={c.userId}>
                        {personName(c)}{c.jobTitle ? ` · ${c.jobTitle}` : ""}
                      </option>
                    ))}
                  </select>
                  <button type="button" disabled={busy || !addSel}
                    onClick={async () => { if (await post({ action: "add", branchId: b.id, userId: Number(addSel) })) { setAddSel(""); setAddFor(null); } }}
                    className="btn-primary disabled:opacity-50">เพิ่ม</button>
                  <button type="button" onClick={() => { setAddFor(null); setAddSel(""); }} className="btn-secondary">ยกเลิก</button>
                </>
              ) : (
                <button type="button" onClick={() => { setAddFor(b.id); setErr(null); }} disabled={busy || b.candidates.length === 0}
                  className="btn-secondary disabled:opacity-50">
                  + เพิ่มคนเข้าผัง{b.candidates.length === 0 ? " (ทุกคนอยู่ในผังแล้ว)" : ""}
                </button>
              )}
            </div>

            {b.members.length === 0 ? (
              <p className="text-sm text-slate-400 py-8 text-center">ยังไม่มีใครในผังของสาขานี้ — กด “เพิ่มคนเข้าผัง”</p>
            ) : (
              <BranchTree branch={b} editable onEdit={(userId) => { setEditing({ branchId: b.id, userId }); setErr(null); }} />
            )}
          </div>
        ))
      )}

      <p className="text-xs text-slate-400">
        เส้นสาย = ใครดูแลใคร (หัวหน้าอยู่บน) · ป้ายสี = แผนก · คนที่ยังไม่ได้กำหนดหัวหน้าจะอยู่บนสุด
      </p>

      {/* Edit dialog */}
      {editing && editMember && editBranch && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setEditing(null); }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md my-8 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-slate-800">{personName(editMember)}</h3>
              <button type="button" onClick={() => setEditing(null)} disabled={busy}
                className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
            </div>
            {editMember.jobTitle && <p className="text-xs text-slate-500 -mt-2">{editMember.jobTitle}</p>}

            <label className="block">
              <span className="text-xs text-slate-500">แผนก</span>
              <input key={`dept-${editMember.userId}-${nonce}`} className="input" list={`dept-${editBranch.id}`}
                defaultValue={editMember.department ?? ""} maxLength={60}
                placeholder="เช่น FOH, BOH, ครัว, บริการ"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (editMember.department ?? "")) post({ action: "department", branchId: editBranch.id, userId: editMember.userId, department: v || null });
                }} />
              <datalist id={`dept-${editBranch.id}`}>
                {editBranch.departments.map((d) => <option key={d} value={d} />)}
              </datalist>
            </label>

            <label className="block">
              <span className="text-xs text-slate-500">หัวหน้าโดยตรง (ขึ้นตรงกับ)</span>
              <select key={`mgr-${editMember.userId}-${nonce}`} className="input"
                defaultValue={editMember.reportsToUserId != null ? String(editMember.reportsToUserId) : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  post({ action: "manager", branchId: editBranch.id, userId: editMember.userId, managerId: v ? Number(v) : null });
                }}>
                <option value="">— ไม่มี (อยู่บนสุด) —</option>
                {editBranch.members.filter((m) => m.userId !== editMember.userId).map((m) => (
                  <option key={m.userId} value={m.userId}>{personName(m)}</option>
                ))}
              </select>
            </label>

            <div className="flex justify-between items-center pt-1">
              <button type="button" disabled={busy}
                onClick={async () => { if (await post({ action: "remove", branchId: editBranch.id, userId: editMember.userId })) setEditing(null); }}
                className="text-sm text-rose-600 hover:underline disabled:opacity-50">ลบออกจากผัง</button>
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
  branch: OrgBranchData; editable: boolean; onEdit: (userId: number) => void;
}) {
  const roots = useMemo(() => buildTree(branch.members), [branch.members]);
  if (roots.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <div className="orgtree inline-block min-w-full text-center">
        <ul>
          {roots.map((n) => <OrgNode key={n.userId} node={n} editable={editable} onEdit={onEdit} />)}
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

function OrgNode({ node, editable, onEdit }: { node: TreeNode; editable: boolean; onEdit: (userId: number) => void }) {
  return (
    <li>
      <div className={`inline-block align-top rounded-xl border px-3 py-2 bg-white shadow-sm text-left ${editable ? "cursor-pointer hover:border-brand" : "border-slate-200"} ${editable ? "border-slate-200" : ""}`}
        onClick={editable ? () => onEdit(node.userId) : undefined}
        role={editable ? "button" : undefined}>
        <div className="font-semibold text-slate-800 text-sm whitespace-nowrap">{personName(node)}</div>
        {node.jobTitle && <div className="text-[11px] text-slate-500 whitespace-nowrap">{node.jobTitle}</div>}
        {node.department && (
          <span className={`inline-block mt-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${deptColor(node.department)}`}>
            {node.department}
          </span>
        )}
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => <OrgNode key={c.userId} node={c} editable={editable} onEdit={onEdit} />)}
        </ul>
      )}
    </li>
  );
}
