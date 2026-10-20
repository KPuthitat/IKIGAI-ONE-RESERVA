"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtMoney } from "@/lib/format";
import { apiUrl } from "@/lib/url";
import PinPromptModal from "@/app/components/PinPromptModal";

type Person = { userId: number; name: string; meetings: number; minutes: number; gross: number };

// Editable เบี้ยประชุม summary (owner 2026-10-20): the approver adjusts each amount, confirms with the PIN, and the
// amounts flow into every person's row below (the purple "เบี้ยประชุม" chip) as the month's meeting fee.
export default function SvcMeetingFeeSummary({ yearMonth, people, confirmed, canEdit }: {
  yearMonth: string; people: Person[]; confirmed: { by: string | null; at: string } | null; canEdit: boolean;
}) {
  const router = useRouter();
  const [amounts, setAmounts] = useState<Record<number, string>>(() => Object.fromEntries(people.map((p) => [p.userId, String(p.gross)])));
  const [pinOpen, setPinOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const val = (id: number) => { const n = Number((amounts[id] ?? "").replace(/,/g, "")); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; };
  const total = people.reduce((s, p) => s + val(p.userId), 0);
  const dirty = people.some((p) => val(p.userId) !== p.gross);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="py-1.5 pr-3">ชื่อ</th>
              <th className="py-1.5 pr-3 text-right">ประชุม (ครั้ง)</th>
              <th className="py-1.5 pr-3 text-right">เวลา (ชม.)</th>
              <th className="py-1.5 pr-3 text-right">เบี้ยประชุม (ก่อนภาษี)</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.userId} className="border-b border-slate-100 last:border-0">
                <td className="py-1.5 pr-3 text-slate-800">{p.name}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{p.meetings || "—"}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{p.minutes ? (p.minutes / 60).toFixed(2) : "—"}</td>
                <td className="py-1.5 pr-3 text-right">
                  {canEdit
                    ? <input className="input !w-28 text-right tabular-nums" inputMode="decimal" value={amounts[p.userId] ?? ""} onChange={(e) => setAmounts((a) => ({ ...a, [p.userId]: e.target.value }))} />
                    : <span className="tabular-nums">{fmtMoney(p.gross)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-medium">
              <td className="py-1.5 pr-3" colSpan={3}>รวม</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{fmtMoney(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <button type="button" className="btn-primary text-sm" onClick={() => { setMsg(null); setPinOpen(true); }}>
            {confirmed ? (dirty ? "ยืนยันยอดที่แก้ไข" : "ยืนยันอีกครั้ง") : "ยืนยันเบี้ยประชุม แล้วใส่ในยอดของแต่ละคน"}
          </button>
        )}
        {confirmed
          ? <span className="text-xs text-emerald-700">✓ ยืนยันแล้ว{confirmed.by ? ` โดย ${confirmed.by}` : ""} — ยอดนี้อยู่ในช่อง “เบี้ยประชุม” ของแต่ละคนด้านล่างแล้ว</span>
          : <span className="text-xs text-amber-600">ยังไม่ยืนยัน — ยอดนี้ยังไม่ถูกใส่ในช่อง “เบี้ยประชุม” ของแต่ละคน</span>}
        {msg && <span className="text-xs text-rose-600">{msg}</span>}
      </div>
      {pinOpen && (
        <PinPromptModal
          title="ยืนยันเบี้ยประชุมเดือนนี้"
          description={<p className="text-xs text-slate-600">ยอดเบี้ยประชุมรวม ฿{fmtMoney(total)} ({people.filter((p) => val(p.userId) > 0).length} คน) จะถูกใส่ในช่อง “เบี้ยประชุม” ของแต่ละคนด้านล่าง และจ่ายพร้อมเซอร์วิสชาร์จ</p>}
          submitLabel="ยืนยัน"
          onClose={() => setPinOpen(false)}
          onSubmit={async (pin) => {
            const res = await fetch(apiUrl("/api/admin/persona/service-charge/meeting-fee/confirm"), {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ year_month: yearMonth, pin, items: people.map((p) => ({ user_id: p.userId, amount: val(p.userId) })) })
            });
            const j = await res.json().catch(() => ({}));
            if (!res.ok || !j?.ok) return { ok: false as const, message: j?.message ?? j?.error ?? "ยืนยันไม่สำเร็จ" };
            setPinOpen(false);
            router.refresh();
            return { ok: true as const };
          }}
        />
      )}
    </div>
  );
}
