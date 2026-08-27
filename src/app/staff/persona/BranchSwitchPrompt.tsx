"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

// Clock-page pop-up (owner 2026-07-31): น้องๆ ที่วันนี้มีชื่อทำงานอีกสาขามักกดเข้างาน
// ไม่ได้เพราะยังไม่ได้เปลี่ยนสาขา. When the active branch has NO shift today but the
// staff IS rostered at another branch, this pops up on the clock page and offers a
// one-tap switch to the right branch (POST /api/branch → refresh). Dismissible.
export default function BranchSwitchPrompt({
  nickname, branches
}: {
  nickname: string;
  branches: Array<{ id: number; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!open || branches.length === 0) return null;

  async function switchTo(branchId: number) {
    setBusyId(branchId);
    setErr(null);
    try {
      const res = await fetch(apiUrl("/api/branch"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch_id: branchId })
      });
      if (!res.ok) { setErr("เปลี่ยนสาขาไม่สำเร็จ ลองใหม่อีกครั้ง"); return; }
      setOpen(false);
      router.refresh();
    } catch {
      setErr("เปลี่ยนสาขาไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setBusyId(null);
    }
  }

  const one = branches.length === 1 ? branches[0] : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="text-center space-y-1">
          <h3 className="font-bold text-slate-800">เปลี่ยนสาขาก่อนลงเวลา</h3>
          <p className="text-sm text-slate-600 leading-relaxed">
            วันนี้ <b>{nickname}</b> มีชื่อทำงานที่{" "}
            {one ? <b>{one.name}</b> : "สาขาอื่น"} —{" "}
            กดเปลี่ยนสาขาก่อน แล้วค่อยกดเข้างานนะครับ
          </p>
        </div>

        {err && <p className="text-sm text-rose-600 text-center">{err}</p>}

        <div className="space-y-2">
          {branches.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => switchTo(b.id)}
              disabled={busyId !== null}
              className="w-full py-3 rounded-xl bg-brand text-white text-sm font-bold active:scale-95 transition disabled:opacity-50"
            >
              {busyId === b.id ? "กำลังเปลี่ยน…" : `เปลี่ยนไปสาขา ${b.name}`}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busyId !== null}
          className="w-full py-2 rounded-xl border border-slate-300 text-slate-600 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          ไว้ทีหลัง
        </button>
      </div>
    </div>
  );
}
