"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

// Admin uploader for the RECRUITA apply-form PDPA policy IMAGE.
// Standalone client component (its own buttons) so it lives OUTSIDE
// the main settings <form> — avoids nested-form submit conflicts.
// Posts multipart to /api/admin/recruita/pdpa-image; the apply form
// links candidates to the public /api/recruita/pdpa-image serve route.

export default function PdpaImageUploader({ hasImage }: { hasImage: boolean }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Cache-bust so a freshly-replaced image shows immediately in the
  // "view current" link.
  const viewUrl = apiUrl(`/api/recruita/pdpa-image?t=${Date.now()}`);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await fetch(apiUrl("/api/admin/recruita/pdpa-image"), {
        method: "POST",
        body: fd
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message ?? j.error ?? "อัปโหลดไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: "✓ อัปโหลดเรียบร้อย" });
      setFile(null);
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: "เกิดข้อผิดพลาด กรุณาลองใหม่" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/recruita/pdpa-image"), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.error ?? "ลบไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: "ลบรูปแล้ว — ฟอร์มจะกลับไปใช้ข้อความมาตรฐาน" });
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: "เกิดข้อผิดพลาด กรุณาลองใหม่" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="text-lg font-bold text-slate-800">
          นโยบาย PDPA แบบรูปภาพ · ใบสมัครงาน
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          อัปโหลดรูปนโยบายคุ้มครองข้อมูล (PNG / JPG / WebP) — ผู้สมัครจะเห็นปุ่ม
          &quot;เปิดดูนโยบาย&quot; ในฟอร์ม แทนการอ่านข้อความยาวๆ
        </p>
      </div>

      {hasImage ? (
        <div className="flex items-center gap-3 text-sm flex-wrap bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          <span className="text-emerald-700 font-bold">✓ มีรูปนโยบายแล้ว</span>
          <a href={viewUrl} target="_blank" rel="noopener noreferrer"
            className="underline text-emerald-800 font-semibold">
            เปิดดูรูปปัจจุบัน
          </a>
          <button type="button" onClick={remove} disabled={busy}
            className="text-rose-600 hover:underline ml-auto disabled:opacity-50">
            ลบรูป
          </button>
        </div>
      ) : (
        <p className="text-xs text-slate-400">
          ยังไม่ได้อัปโหลด — ระบบจะแสดงข้อความ PDPA มาตรฐานในฟอร์มแทน
        </p>
      )}

      <div className="flex items-center gap-2">
        <input type="file" accept="image/png,image/jpeg,image/webp"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setMsg(null); }}
          disabled={busy}
          className="text-sm flex-1 file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold" />
        <button type="button" onClick={upload} disabled={busy || !file}
          className="btn-primary px-4 py-2 text-sm disabled:opacity-50 whitespace-nowrap">
          {busy ? "กำลังอัปโหลด…" : hasImage ? "เปลี่ยนรูป" : "อัปโหลด"}
        </button>
      </div>

      {msg && (
        <div className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
