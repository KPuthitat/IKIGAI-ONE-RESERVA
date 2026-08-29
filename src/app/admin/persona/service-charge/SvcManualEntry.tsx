"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";

// Manual SVC entry for a pre-system month (owner 2026-07-21). Months before the
// system went live have no clock/roster data, so the owner types each staff's
// GROSS SVC by hand. The system withholds 3% for 'wht' staff live and the same
// rows post to ACCOUNTA like a normal month. Editable only while the payout
// batch is still draft (canEdit); once finalized it renders read-only.
type Row = {
  userId: number;
  displayName: string;
  employmentType: string | null;
  taxMode: "sso" | "wht";
  gross: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export default function SvcManualEntry({
  yearMonth, rows, whtRate, canEdit
}: {
  yearMonth: string;
  rows: Row[];
  whtRate: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  // Keyed by userId → the raw text in the input, so a half-typed "12." doesn't
  // get clobbered. Seed from the server gross.
  const [vals, setVals] = useState<Record<number, string>>(() => {
    const o: Record<number, string> = {};
    for (const r of rows) o[r.userId] = r.gross ? String(r.gross) : "";
    return o;
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grossOf = (userId: number) => {
    const n = Number(vals[userId]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const whtOf = (r: Row) => (r.taxMode === "wht" ? round2(grossOf(r.userId) * whtRate) : 0);
  const netOf = (r: Row) => round2(grossOf(r.userId) - whtOf(r));

  const totals = useMemo(() => {
    let gross = 0, wht = 0, net = 0;
    for (const r of rows) { gross += grossOf(r.userId); wht += whtOf(r); net += netOf(r); }
    return { gross: round2(gross), wht: round2(wht), net: round2(net) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vals, rows]);

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const allocations = rows.map((r) => ({ userId: r.userId, gross: grossOf(r.userId) }));
      const res = await fetch(apiUrl("/api/admin/persona/service-charge/manual"), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ yearMonth, allocations })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.message || data.error || "บันทึกไม่สำเร็จ"); return; }
      setSaved(true);
      router.refresh();
    } catch {
      setError("เชื่อมต่อไม่ได้");
    } finally {
      setBusy(false);
    }
  }

  const typeBadge = (t: string | null) =>
    t === "ft"
      ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">ประจำ</span>
      : t === "pt"
      ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">พาร์ทไทม์</span>
      : null;

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
        <h2 className="font-bold text-slate-800 text-sm">
          กรอกเซอร์วิสชาร์จเอง — {yearMonth}
        </h2>
        {canEdit && (
          <div className="flex items-center gap-2">
            {saved && !error && <span className="text-xs text-emerald-600">✓ บันทึกแล้ว</span>}
            <button type="button" disabled={busy} onClick={save}
              className="text-sm px-3 py-1.5 rounded-full bg-slate-800 hover:bg-slate-900 text-white font-medium disabled:opacity-50">
              {busy ? "..." : "บันทึก"}
            </button>
          </div>
        )}
      </div>
      <p className="text-xs text-slate-500 mb-3">
        เดือนก่อนเริ่มใช้ระบบ — กรอก<strong>ยอดก่อนหักภาษี</strong>ของแต่ละคน ระบบจะหัก ณ ที่จ่าย 3%
        ให้คนกลุ่มหักภาษีอัตโนมัติ แล้วลงบัญชีเหมือนเดือนปกติ
        {!canEdit && <span className="text-amber-700"> · ปิดยอดแล้ว (อ่านอย่างเดียว)</span>}
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-400 py-6 text-center">ไม่มีพนักงานที่รับเซอร์วิสชาร์จในสาขานี้</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">พนักงาน</th>
                <th className="py-2 pr-3 text-right">ยอดก่อนหักภาษี</th>
                <th className="py-2 pr-3 text-right">หัก ณ ที่จ่าย 3%</th>
                <th className="py-2 pr-3 text-right">ยอดจ่ายจริง</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className="border-b border-slate-100">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800 flex items-center gap-1.5 flex-wrap">
                      <span>{r.displayName}</span>
                      {typeBadge(r.employmentType)}
                      {r.taxMode === "wht" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">หักภาษี</span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {canEdit ? (
                      <input
                        type="number" inputMode="decimal" min={0} step="0.01"
                        value={vals[r.userId] ?? ""}
                        onChange={(e) => { setVals((v) => ({ ...v, [r.userId]: e.target.value })); setSaved(false); }}
                        placeholder="0"
                        className="input w-28 text-right tabular-nums" />
                    ) : (
                      <span className="tabular-nums text-slate-700">{fmtMoney(grossOf(r.userId))}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-rose-600">
                    {whtOf(r) > 0 ? `−${fmtMoney(whtOf(r))}` : "—"}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums font-bold text-emerald-700">
                    {fmtMoney(netOf(r))}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-medium">
                <td className="py-2 pr-3">รวมทั้งหมด ({rows.length} คน)</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(totals.gross)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-rose-600">
                  {totals.wht > 0 ? `−${fmtMoney(totals.wht)}` : "—"}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-emerald-700">{fmtMoney(totals.net)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
    </div>
  );
}
