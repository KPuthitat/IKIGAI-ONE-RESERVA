"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

const NAVY = "#0B1F3A";
const GOLD = "#C9A227";

export type PendingOrder = {
  code: string; staffName: string; menuName: string | null;
  mealClass: string; credits: number; baht: number;
};

const ERR_TH: Record<string, string> = {
  not_found: "ไม่พบรหัสนี้",
  already_confirmed: "รหัสนี้ยืนยันไปแล้ว",
  not_pending: "รหัสนี้ใช้ไม่ได้แล้ว",
  insufficient: "เครดิตพนักงานไม่พอ (อาจถูกใช้ไปแล้ว)",
  override_reason_required: "กรุณากรอกเหตุผล",
};

export default function MealpassConfirmClient({ pending }: { pending: PendingOrder[] }) {
  const router = useRouter();
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ code: string; text: string; ok: boolean } | null>(null);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  async function confirm(code: string, override = false) {
    if (!code.trim()) return;
    setBusy(code); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/mealpass/confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), action: "confirm", override, overrideReason: override ? reason : undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg({ code, text: "ยืนยันแล้ว ✓", ok: true });
        setOverrideFor(null); setReason(""); setManual("");
        router.refresh();
      } else if (j.error === "override_required") {
        setOverrideFor(code);   // ask for a reason (past cutoff)
      } else {
        setMsg({ code, text: ERR_TH[j.error] ?? "ยืนยันไม่สำเร็จ", ok: false });
      }
    } catch { setMsg({ code, text: "เชื่อมต่อไม่ได้", ok: false }); }
    setBusy(null);
  }

  return (
    <div className="space-y-4">
      {/* Manual code entry */}
      <div className="card">
        <label className="label !text-xs">กรอกรหัส MP-xxxx</label>
        <div className="flex gap-2">
          <input className="input flex-1 font-mono uppercase" value={manual}
            onChange={(e) => setManual(e.target.value.toUpperCase())} placeholder="MP-XXXXXX" />
          <button className="btn-primary" disabled={!manual.trim() || busy === manual} onClick={() => confirm(manual)}>ยืนยัน</button>
        </div>
        {msg && !pending.some((p) => p.code === msg.code) && (
          <div className={`mt-2 text-sm ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</div>
        )}
      </div>

      {/* Pending list */}
      <div>
        <div className="text-sm font-semibold mb-2" style={{ color: NAVY }}>รอยืนยันวันนี้ ({pending.length})</div>
        {pending.length === 0 ? (
          <div className="card text-sm text-slate-400">ไม่มีรายการรอยืนยัน</div>
        ) : (
          <div className="space-y-2">
            {pending.map((p) => (
              <div key={p.code} className="card">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono font-bold tracking-widest" style={{ color: GOLD }}>{p.code}</div>
                    <div className="text-sm text-slate-700 truncate">{p.staffName} · {p.menuName}</div>
                    <div className="text-xs text-slate-500">
                      {p.mealClass === "cash" ? `เงินสด ${p.baht.toLocaleString()} บาท` : `หัก ${p.credits} เครดิต`}
                    </div>
                  </div>
                  <button className="btn-primary shrink-0" disabled={busy === p.code} onClick={() => confirm(p.code)}>
                    {busy === p.code ? "…" : "ยืนยัน"}
                  </button>
                </div>
                {overrideFor === p.code && (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <div className="text-xs text-amber-700 mb-1">เลยเวลาใช้สิทธิ์แล้ว — ต้องระบุเหตุผลเพื่ออนุมัติ (override)</div>
                    <div className="flex gap-2">
                      <input className="input flex-1 !text-sm" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เหตุผล เช่น ลูกค้าแน่นช่วงเที่ยง" />
                      <button className="rounded-md px-3 py-2 text-sm font-medium text-white" style={{ background: GOLD }}
                        disabled={!reason.trim() || busy === p.code} onClick={() => confirm(p.code, true)}>อนุมัติ</button>
                    </div>
                  </div>
                )}
                {msg?.code === p.code && (
                  <div className={`mt-2 text-sm ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
