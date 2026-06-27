"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { HealthFacility } from "@/lib/health-facility";
import { useConfirm } from "@/app/components/useConfirm";

type Editing = {
  id: number | null;
  name: string;
  license_no: string;
  address: string;
  logo_path: string;
  make_default: boolean;
};

const BLANK: Editing = {
  id: null, name: "", license_no: "", address: "",
  logo_path: "/ahc-logo.png", make_default: false
};

export default function FacilitiesClient({ facilities }: { facilities: HealthFacility[] }) {
  const { confirm, alert, ConfirmDialog } = useConfirm();
  const router = useRouter();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function openNew() {
    setErr(null);
    setEditing({ ...BLANK, make_default: facilities.length === 0 });
  }
  function openEdit(f: HealthFacility) {
    setErr(null);
    setEditing({
      id: f.id, name: f.name, license_no: f.license_no ?? "",
      address: f.address ?? "", logo_path: f.logo_path ?? "",
      make_default: f.is_default === 1
    });
  }

  async function save() {
    if (!editing) return;
    if (editing.name.trim().length < 2) { setErr("กรอกชื่อสถานพยาบาล"); return; }
    setBusy(true); setErr(null);
    try {
      const body = {
        name: editing.name.trim(),
        license_no: editing.license_no.trim() || null,
        address: editing.address.trim() || null,
        logo_path: editing.logo_path.trim() || null,
        make_default: editing.make_default
      };
      const res = editing.id
        ? await fetch(apiUrl(`/api/admin/health/facilities/${editing.id}`), {
            method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
          })
        : await fetch(apiUrl("/api/admin/health/facilities"), {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
          });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr("บันทึกไม่สำเร็จ"); return; }
      setEditing(null);
      router.refresh();
    } finally { setBusy(false); }
  }

  async function remove(f: HealthFacility) {
    const ok = await confirm({ title: `ลบสถานพยาบาล "${f.name}"?`, confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger" });
    if (ok === null) return;
    const res = await fetch(apiUrl(`/api/admin/health/facilities/${f.id}`), { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) {
      await alert({ title: j.error === "last_facility" ? "ต้องเหลือสถานพยาบาลอย่างน้อย 1 แห่ง" : "ลบไม่สำเร็จ", variant: "danger" });
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {ConfirmDialog}
      <div className="space-y-2">
        {facilities.map((f) => (
          <div key={f.id} className="card flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3">
              {f.logo_path && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.logo_path} alt="" className="w-10 h-10 rounded object-contain bg-slate-50 border border-slate-100" />
              )}
              <div>
                <div className="font-bold text-slate-800">
                  {f.name}
                  {f.is_default === 1 && (
                    <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-bold">หลัก</span>
                  )}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {f.license_no ? <>ใบอนุญาตเลขที่ {f.license_no}</> : <span className="text-slate-400">ยังไม่ระบุเลขใบอนุญาต</span>}
                </div>
                {f.address && <div className="text-xs text-slate-500">{f.address}</div>}
              </div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => openEdit(f)}
                className="text-xs text-brand hover:underline">แก้ไข</button>
              <button type="button" onClick={() => remove(f)}
                className="text-xs text-rose-600 hover:underline">ลบ</button>
            </div>
          </div>
        ))}
        {facilities.length === 0 && (
          <div className="card text-sm text-slate-400 text-center py-6">ยังไม่มีสถานพยาบาล</div>
        )}
      </div>

      {!editing && (
        <button type="button" onClick={openNew} className="btn-primary px-4 py-2 text-sm">
          + เพิ่มสถานพยาบาล
        </button>
      )}

      {editing && (
        <div className="card space-y-3">
          <h2 className="font-bold text-slate-800 text-sm">
            {editing.id ? "แก้ไขสถานพยาบาล" : "เพิ่มสถานพยาบาล"}
          </h2>
          <div>
            <label className="label">ชื่อสถานพยาบาล *</label>
            <input className="input" value={editing.name} maxLength={200}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="เช่น แอทโฮมคลินิกเวชกรรม สาขาบ่อวิน" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">เลขที่ใบอนุญาตประกอบกิจการสถานพยาบาล</label>
              <input className="input" value={editing.license_no} maxLength={100}
                onChange={(e) => setEditing({ ...editing, license_no: e.target.value })}
                placeholder="เช่น 20101005164" />
            </div>
            <div>
              <label className="label">โลโก้ (path ในระบบ)</label>
              <input className="input" value={editing.logo_path} maxLength={300}
                onChange={(e) => setEditing({ ...editing, logo_path: e.target.value })}
                placeholder="/ahc-logo.png" />
            </div>
          </div>
          <div>
            <label className="label">ที่อยู่สถานพยาบาล</label>
            <textarea className="input text-sm" rows={2} value={editing.address} maxLength={500}
              onChange={(e) => setEditing({ ...editing, address: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={editing.make_default}
              onChange={(e) => setEditing({ ...editing, make_default: e.target.checked })} />
            ตั้งเป็นสถานพยาบาลหลัก (ใช้แสดงในพอร์ทัลสุขภาพ)
          </label>
          {err && <p className="text-sm text-rose-600">✗ {err}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setEditing(null)} disabled={busy}
              className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium">
              ยกเลิก
            </button>
            <button type="button" onClick={save} disabled={busy}
              className="flex-1 btn-primary py-2.5 text-sm disabled:opacity-50">
              {busy ? "กำลังบันทึก…" : "บันทึก"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
