"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

// Create a WI/WP document (rev 1 draft) → jump to its detail page.
export default function QualityCreate({ branches }: { branches: Array<{ id: number; name: string }> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [docType, setDocType] = useState<"WI" | "WP">("WI");
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [branchId, setBranchId] = useState<string>("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (title.trim() === "") { setErr("กรุณากรอกชื่อเอกสาร"); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/quality/documents"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          doc_type: docType, title, department: department.trim() || undefined,
          branch_id: branchId ? Number(branchId) : null, content: content.trim() || undefined
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.message || j.error || "สร้างไม่สำเร็จ"); return; }
      router.push(`/admin/persona/quality/${j.documentId}`);
    } catch { setErr("เชื่อมต่อไม่ได้"); }
    finally { setBusy(false); }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => { setOpen(true); setErr(null); }}
        className="text-sm px-4 py-2 rounded-lg bg-brand text-white font-medium hover:opacity-90 whitespace-nowrap">
        + สร้างเอกสาร
      </button>
    );
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-lg p-5 space-y-3">
        <h2 className="font-bold text-slate-800">สร้างเอกสารคุณภาพใหม่</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">ประเภท</label>
            <select className="input" value={docType} onChange={(e) => setDocType(e.target.value as "WI" | "WP")}>
              <option value="WI">วิธีปฏิบัติงาน (WI)</option>
              <option value="WP">ระเบียบปฏิบัติ (WP)</option>
            </select>
          </div>
          <div>
            <label className="label">สาขา</label>
            <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">ทุกสาขา</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="label">ชื่อเอกสาร *</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น การล้างมือ 7 ขั้นตอน" />
        </div>
        <div>
          <label className="label">แผนก/หมวด (ถ้ามี)</label>
          <input className="input" value={department} onChange={(e) => setDepartment(e.target.value)} />
        </div>
        <div>
          <label className="label">เนื้อหา (เขียนในระบบ — ถ้ามี)</label>
          <textarea className="input" rows={5} value={content} onChange={(e) => setContent(e.target.value)}
            placeholder="พิมพ์ขั้นตอนการทำงาน… (แนบไฟล์เพิ่มได้ในหน้าเอกสาร)" />
        </div>
        {err && <p className="text-xs text-rose-600">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => setOpen(false)}
            className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 text-slate-500">ยกเลิก</button>
          <button type="button" disabled={busy} onClick={submit}
            className="text-sm px-4 py-1.5 rounded-lg bg-brand text-white font-medium disabled:opacity-40">
            {busy ? "..." : "สร้าง (ร่าง)"}
          </button>
        </div>
      </div>
    </div>
  );
}
