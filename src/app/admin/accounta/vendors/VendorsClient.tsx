"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { useConfirm } from "@/app/components/useConfirm";

type Vendor = { id: number; name: string; tax_id: string | null; category: string | null; needs_review: number };

export default function VendorsClient({ initialVendors }: { initialVendors: Vendor[] }) {
  const { confirm, ConfirmDialog } = useConfirm();
  const [vendors, setVendors] = useState<Vendor[]>(initialVendors);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // add form
  const [name, setName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [category, setCategory] = useState("");

  // inline edit
  const [editId, setEditId] = useState<number | null>(null);
  const [eName, setEName] = useState("");
  const [eTax, setETax] = useState("");
  const [eCat, setECat] = useState("");

  async function call(method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>, qs?: string) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/vendors${qs ?? ""}`), {
        method, headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return false; }
      if (j.vendors) setVendors(j.vendors);
      return true;
    } finally { setBusy(false); }
  }

  async function add() {
    if (!name.trim()) return;
    if (await call("POST", { name: name.trim(), tax_id: taxId.trim() || null, category: category.trim() || null })) {
      setName(""); setTaxId(""); setCategory("");
    }
  }
  function startEdit(v: Vendor) {
    setEditId(v.id); setEName(v.name); setETax(v.tax_id ?? ""); setECat(v.category ?? "");
  }
  async function saveEdit(id: number) {
    if (!eName.trim()) return;
    if (await call("PATCH", { id, name: eName.trim(), tax_id: eTax.trim() || null, category: eCat.trim() || null })) {
      setEditId(null);
    }
  }
  async function remove(v: Vendor) {
    const ok = await confirm({
      title: "ลบคู่ค้า", variant: "danger", confirmLabel: "ลบ", cancelLabel: "ยกเลิก",
      body: <>ลบ <b>{v.name}</b> ออกจากรายชื่อคู่ค้า? บิลเก่ายังคงชื่อร้านเดิมไว้</>
    });
    if (ok === null) return;
    await call("DELETE", undefined, `?id=${v.id}`);
  }

  const filtered = vendors.filter((v) =>
    !q.trim() || v.name.toLowerCase().includes(q.toLowerCase()) || (v.tax_id ?? "").includes(q.trim()));

  return (
    <div className="space-y-4">
      {ConfirmDialog}
      {err && <p className="text-sm text-rose-600">{err}</p>}

      {/* Add */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">เพิ่มคู่ค้า</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input className="input sm:col-span-1" value={name} placeholder="ชื่อบริษัท / ร้าน"
            onChange={(e) => setName(e.target.value)} />
          <input className="input" value={taxId} inputMode="numeric" maxLength={20} placeholder="เลขผู้เสียภาษี 13 หลัก"
            onChange={(e) => setTaxId(e.target.value)} />
          <input className="input" value={category} placeholder="หมวดเริ่มต้น (ถ้ามี)"
            onChange={(e) => setCategory(e.target.value)} />
        </div>
        <button type="button" onClick={add} disabled={busy || !name.trim()}
          className="btn-primary text-sm disabled:opacity-50">+ เพิ่มคู่ค้า</button>
      </div>

      <input className="input" value={q} placeholder="ค้นหาชื่อ / เลขผู้เสียภาษี" onChange={(e) => setQ(e.target.value)} />

      {filtered.length === 0 ? (
        <div className="card text-center py-8 text-slate-400 text-sm">{vendors.length === 0 ? "ยังไม่มีคู่ค้า" : "ไม่พบคู่ค้าที่ค้นหา"}</div>
      ) : (
        <div className="card p-0 divide-y divide-slate-50">
          {filtered.map((v) => (
            <div key={v.id} className="px-3 py-2">
              {editId === v.id ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input className="input" value={eName} onChange={(e) => setEName(e.target.value)} placeholder="ชื่อ" />
                    <input className="input" value={eTax} inputMode="numeric" onChange={(e) => setETax(e.target.value)} placeholder="เลขผู้เสียภาษี" />
                    <input className="input" value={eCat} onChange={(e) => setECat(e.target.value)} placeholder="หมวด" />
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => saveEdit(v.id)} disabled={busy || !eName.trim()} className="btn-primary text-xs disabled:opacity-50">บันทึก</button>
                    <button type="button" onClick={() => setEditId(null)} disabled={busy} className="btn-secondary text-xs">ยกเลิก</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-800 flex items-center gap-1.5 flex-wrap">
                      {v.name}
                      {!!v.needs_review && <span className="text-[10px] font-normal bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-1.5 py-px">รอตรวจ</span>}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {v.tax_id ? `เลขภาษี ${v.tax_id}` : "ยังไม่มีเลขภาษี"}{v.category ? ` · ${v.category}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button type="button" onClick={() => startEdit(v)} disabled={busy} className="text-xs text-slate-500 hover:text-brand">แก้ไข</button>
                    <button type="button" onClick={() => remove(v)} disabled={busy} className="text-xs text-rose-500 hover:underline">ลบออก</button>
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
