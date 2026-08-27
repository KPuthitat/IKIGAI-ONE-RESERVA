"use client";

// Sandbox card for /admin/insigna — super_admin-only test-event fire
// buttons. Each click POSTs to /api/admin/insigna/test-event with a
// kind, which mints synthetic INSIGNA rows tagged "__test__" so the
// wipe action can vacuum them out cleanly.
//
// We deliberately KEEP the sandbox separate from the real dashboard
// readouts — the goal is to make it crystal clear that this is
// "fake data for testing", not a normal operator action.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type Kind = "customer" | "reservation" | "full_visit" | "with_feedback" | "wipe";

const ACTIONS: Array<{ kind: Kind; label: string; hint: string }> = [
  { kind: "customer",      label: "+ Customer",       hint: "upsert 1 row" },
  { kind: "reservation",   label: "+ Reservation",    hint: "customer + reservation" },
  { kind: "full_visit",    label: "+ Visit + Orders", hint: "+ persona/churn/attribution recompute" },
  { kind: "with_feedback", label: "+ Feedback",       hint: "full_visit + rating + comment" }
];

export default function Sandbox() {
  const router = useRouter();
  const [busy, setBusy] = useState<Kind | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [wipeConfirm, setWipeConfirm] = useState(false);

  async function fire(kind: Kind): Promise<void> {
    setBusy(kind);
    setLastResult(null);
    try {
      const res = await fetch(apiUrl("/api/admin/insigna/test-event"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLastResult(`✗ ${j.message ?? j.error ?? res.statusText}`);
        return;
      }
      if (kind === "wipe") {
        setLastResult(`✓ ลบ ${j.wiped?.customers ?? 0} test customers (cascade ลบทุกอย่างที่เกี่ยวข้อง)`);
      } else {
        setLastResult(`✓ ${kind} created · hash: ${String(j.customer_hash ?? "").slice(0, 12)}…`);
      }
      router.refresh();
    } catch {
      setLastResult("✗ network error");
    } finally {
      setBusy(null);
      if (kind === "wipe") setWipeConfirm(false);
    }
  }

  return (
    <div className="card border-dashed border-2 border-amber-300 bg-amber-50/30">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-bold text-amber-800">
            Sandbox · sandbox · sandbox
          </h2>
          <p className="text-[11px] text-amber-700/70 mt-0.5">
            Test events ติด tag <code className="font-mono bg-amber-100 px-1 rounded">__test__</code>
            {" "}เพื่อล้างได้สะอาด · ผลลัพธ์ขึ้นใน dashboard ทันที (รีเฟรชหน้า)
          </p>
        </div>
        <span className="text-[10px] px-2 py-1 rounded-full bg-amber-200 text-amber-900 font-bold">
          super_admin only
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {ACTIONS.map((a) => (
          <button
            key={a.kind}
            type="button"
            onClick={() => fire(a.kind)}
            disabled={!!busy}
            className="text-left p-3 rounded-lg bg-white border border-amber-200 hover:bg-amber-50 transition disabled:opacity-50"
          >
            <div className="text-sm font-bold text-slate-800">
              {busy === a.kind ? "กำลังยิง..." : a.label}
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">{a.hint}</div>
          </button>
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-amber-200/60 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-amber-900 flex-1 min-w-0">
          {lastResult && (
            <span className={lastResult.startsWith("✓") ? "text-emerald-700" : "text-rose-700"}>
              {lastResult}
            </span>
          )}
        </div>
        {wipeConfirm ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-rose-700">แน่ใจ?</span>
            <button
              type="button"
              onClick={() => fire("wipe")}
              disabled={!!busy}
              className="text-xs px-3 py-1.5 rounded-md bg-rose-600 text-white font-bold disabled:opacity-50"
            >
              ใช่ ล้างเลย
            </button>
            <button
              type="button"
              onClick={() => setWipeConfirm(false)}
              disabled={!!busy}
              className="text-xs px-3 py-1.5 rounded-md border border-slate-300 text-slate-700"
            >
              ยกเลิก
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setWipeConfirm(true)}
            disabled={!!busy}
            className="text-xs px-3 py-1.5 rounded-md border border-rose-300 text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            ลบ test data ทั้งหมด
          </button>
        )}
      </div>
    </div>
  );
}
