"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

// Top-of-page actions for /admin/persona/employees:
//   • "+ เพิ่มพนักงานใหม่" — opens a small modal to create a user
//     row + generate an onboarding invite link. The link is shown
//     so admin can copy and send via LINE.
//   • Per-row actions live in the existing EmployeesClient modal;
//     this component is just the "add new" entry point.

type Mode = null | "onboard" | "showLink";

export default function AccountActions({
  branchId, canCreateAdmin
}: {
  branchId: number;
  canCreateAdmin: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Onboard form state
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"staff" | "admin">("staff");
  const [employmentType, setEmploymentType] = useState<"pt" | "ft" | "">("");
  const [jobTitle, setJobTitle] = useState("");

  // Result state — the generated invite link to copy/share
  const [link, setLink] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  function reset() {
    setMode(null); setBusy(false); setErr(null);
    setDisplayName(""); setRole("staff"); setEmploymentType(""); setJobTitle("");
    setLink(null); setExpiresAt(null);
  }

  async function submitOnboard() {
    setErr(null);
    if (!displayName.trim()) { setErr("กรอกชื่อ-นามสกุล"); return; }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/invites"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "onboard",
          display_name: displayName.trim(),
          branch_id: branchId,
          role,
          employment_type: employmentType || undefined,
          job_title: jobTitle.trim() || undefined
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(j.error ?? "เกิดข้อผิดพลาด");
        return;
      }
      setLink(j.url);
      setExpiresAt(j.expires_at);
      setMode("showLink");
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  function copyLink() {
    if (!link) return;
    navigator.clipboard?.writeText(link).catch(() => {});
  }

  return (
    <>
      <div className="flex justify-end">
        <button type="button"
          onClick={() => setMode("onboard")}
          className="text-sm px-4 py-2 rounded-lg bg-brand text-white font-bold hover:opacity-90">
          + เพิ่มพนักงานใหม่
        </button>
      </div>

      {mode === "onboard" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={reset}>
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-3"
            onClick={(e) => e.stopPropagation()}>
            <div>
              <h3 className="font-bold text-slate-800 text-lg">เพิ่มพนักงานใหม่</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                ระบบจะสร้าง user row + ออกลิงก์เชิญให้ส่งทาง LINE
                พนักงานเปิดลิงก์แล้วตั้ง username/password/PIN ของตัวเอง
                ลิงก์ใช้ได้ 7 วัน หมดอายุแล้วต้องออกใหม่
              </p>
            </div>
            <div>
              <label className="label">ชื่อ-นามสกุล (TH) *</label>
              <input className="input" value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="เช่น ฐิติรัตน์ ชุมภูวัน"
                maxLength={120} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">ตำแหน่งสิทธิ์ *</label>
                <select className="input" value={role}
                  onChange={(e) => setRole(e.target.value as "staff" | "admin")}>
                  <option value="staff">พนักงาน (Staff)</option>
                  {canCreateAdmin && <option value="admin">หัวหน้างาน (Admin)</option>}
                </select>
                {!canCreateAdmin && (
                  <p className="text-[10px] text-slate-400 mt-1">
                    สิทธิ์ Admin ตั้งได้โดย Super Admin เท่านั้น
                  </p>
                )}
              </div>
              <div>
                <label className="label">ประเภทการจ้าง</label>
                <select className="input" value={employmentType}
                  onChange={(e) => setEmploymentType(e.target.value as "pt" | "ft" | "")}>
                  <option value="">—</option>
                  <option value="ft">Full-time</option>
                  <option value="pt">Part-time</option>
                </select>
              </div>
            </div>
            <div>
              <label className="label">ตำแหน่งงาน</label>
              <input className="input" value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                placeholder="เช่น พนักงานทั่วไปภายในร้าน"
                maxLength={120} />
            </div>
            {err && <div className="text-sm text-rose-600">✗ {err}</div>}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={reset}
                className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm">
                ยกเลิก
              </button>
              <button type="button" disabled={busy || !displayName.trim()}
                onClick={submitOnboard}
                className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
                {busy ? "กำลังสร้าง..." : "สร้างบัญชี + ออกลิงก์"}
              </button>
            </div>
          </div>
        </div>
      )}

      {mode === "showLink" && link && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={reset}>
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-3"
            onClick={(e) => e.stopPropagation()}>
            <div className="text-center">
              <div className="text-4xl">✓</div>
              <h3 className="font-bold text-slate-800 text-lg mt-2">สร้างบัญชี + ลิงก์เรียบร้อย</h3>
              <p className="text-xs text-slate-500 mt-1">
                ก๊อปลิงก์ด้านล่างส่งให้พนักงานทาง LINE
                ลิงก์หมดอายุ {expiresAt ? new Date(expiresAt).toISOString().slice(0, 10) : "—"}
              </p>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs break-all select-all">
              {link}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={copyLink}
                className="flex-1 py-2.5 rounded-lg border border-brand text-brand text-sm font-bold hover:bg-rose-50">
                📋 คัดลอกลิงก์
              </button>
              <button type="button" onClick={reset}
                className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-bold">
                เสร็จสิ้น
              </button>
            </div>
            <p className="text-[10px] text-slate-400 text-center">
              หมายเหตุ: ลิงก์นี้จะใช้ได้ครั้งเดียว — ส่งให้เฉพาะคนที่ต้องการเท่านั้น
            </p>
          </div>
        </div>
      )}
    </>
  );
}
