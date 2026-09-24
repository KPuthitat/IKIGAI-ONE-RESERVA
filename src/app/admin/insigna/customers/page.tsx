// /admin/insigna/customers — customer directory (owner 2026-09-24).
//
// The VIP list: every customer with linked POS bills, rolled up by spend /
// frequency / recency so the owner can see who their best customers are and
// drill into any one. Privacy-first — each row is the pseudonym (customer_hash)
// plus its POS aggregates, no PII. requireAdmin gate.

import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { listCustomerRollups, type CustomerRollupSort } from "@/lib/insigna";
import { formatLongDate } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "รายชื่อลูกค้า · INSIGNA" };

const money = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;

const SORTS: Array<{ key: CustomerRollupSort; label: string }> = [
  { key: "spend", label: "ยอดซื้อรวม" },
  { key: "visits", label: "ความบ่อย" },
  { key: "recent", label: "มาล่าสุด" }
];

export default function InsignaCustomersPage({ searchParams }: { searchParams: { sort?: string } }) {
  requireAdmin();
  const sort: CustomerRollupSort =
    searchParams.sort === "visits" ? "visits" :
    searchParams.sort === "recent" ? "recent" : "spend";
  const rows = listCustomerRollups({ sort, limit: 500 });

  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin/insigna" className="text-xs text-slate-400 hover:text-brand">← INSIGNA</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-1">รายชื่อลูกค้า · Customer directory</h1>
        <p className="text-sm text-slate-500 mt-1">
          ลูกค้าที่มีบิลผูกไว้ เรียงตามยอดซื้อ/ความบ่อย/ครั้งล่าสุด · ทุกแถวเป็นรหัสนิรนาม ไม่มีข้อมูลส่วนตัว
        </p>
      </div>

      {/* sort tabs */}
      <div className="flex flex-wrap gap-2">
        {SORTS.map((s) => (
          <Link
            key={s.key}
            href={`/admin/insigna/customers?sort=${s.key}`}
            className={`text-sm px-3 py-1.5 rounded-full font-semibold transition ${
              sort === s.key ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {s.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="card text-sm text-slate-400 py-10 text-center">
          ยังไม่มีลูกค้าที่ผูกบิล — ผูกบิลให้ลูกค้าที่หน้าโปรไฟล์ก่อน แล้วรายชื่อจะขึ้นที่นี่
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
              <tr className="border-b border-slate-200">
                <th className="text-left py-2 w-10">#</th>
                <th className="text-left">ลูกค้า</th>
                <th className="text-right">มา (วัน)</th>
                <th className="text-right">บิล</th>
                <th className="text-right">ยอดซื้อรวม</th>
                <th className="text-right">เฉลี่ย/บิล</th>
                <th className="text-right">มาล่าสุด</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.customer_hash} className="border-b border-slate-100 hover:bg-slate-50/60">
                  <td className="py-2 text-slate-400 tabular-nums">{i + 1}</td>
                  <td>
                    <Link href={`/admin/insigna/customers/${r.customer_hash}`}
                      className="font-mono text-xs text-brand hover:underline">
                      {shortHash(r.customer_hash)}
                    </Link>
                  </td>
                  <td className="text-right tabular-nums text-slate-700">{r.distinctDays}</td>
                  <td className="text-right tabular-nums text-slate-500">{r.billCount}</td>
                  <td className="text-right tabular-nums font-bold text-slate-800">฿{money(r.totalNett)}</td>
                  <td className="text-right tabular-nums text-slate-500">฿{money(r.avgNett)}</td>
                  <td className="text-right text-xs text-slate-500">
                    {r.lastVisit ? formatLongDate(r.lastVisit, "th") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
