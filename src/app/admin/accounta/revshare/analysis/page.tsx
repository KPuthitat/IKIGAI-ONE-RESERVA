import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { fmtMoney } from "@/lib/format";
import { isRevshareBranch } from "@/lib/revshare-db";
import { analysisPartners, partnerAnalysis, type MonthRow } from "@/lib/revshare-analysis";
import { TH_MONTHS_FULL } from "@/lib/revshare";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · วิเคราะห์ส่วนแบ่งต่อคู่ค้า" };

const RANGES = [3, 6, 12];
const SETTLE_TH: Record<string, string> = { draft: "ร่างใบวางบิล", issued: "ออกบิลแล้ว", paid: "รับเงินแล้ว" };

function bkkToday(): string { return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10); }
function ymLabel(ym: string): string { const [y, m] = ym.split("-").map(Number); return `${TH_MONTHS_FULL[m - 1]} ${y + 543}`; }
function pct(x: number, digits = 1): string { return `${(x * 100).toFixed(digits)}%`; }

export default function RevshareAnalysisPage({ searchParams }: { searchParams: { partner?: string; months?: string } }) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isRevshareBranch(branchId)) {
    return <div className="card text-sm text-slate-500">ฟีเจอร์นี้ใช้เฉพาะสาขาที่เปิดส่วนแบ่งยอดขาย</div>;
  }
  const partners = analysisPartners(branchId);
  const partnerId = Number(searchParams.partner) || partners[0]?.id || 0;
  const n = RANGES.includes(Number(searchParams.months)) ? Number(searchParams.months) : 6;
  const today = bkkToday();
  const a = partnerId ? partnerAnalysis(partnerId, branchId, today.slice(0, 7), n, today) : null;
  const href = (p: number, m: number) => `/admin/accounta/revshare/analysis?partner=${p}&months=${m}`;

  return (
    <div className="space-y-4">
      <Link href="/admin/accounta/revshare" className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">วิเคราะห์ส่วนแบ่งต่อคู่ค้า</h1>
        <p className="text-sm text-slate-500 mt-1">ดูแนวโน้มยอดขาย ส่วนแบ่ง (GP) หมวดที่ขายดี และวันที่ขายดี ของคู่ค้าแต่ละราย</p>
      </div>

      {partners.length === 0 || !a ? (
        <div className="card text-sm text-slate-500">ยังไม่มีคู่ค้าที่ใช้งานอยู่</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {partners.map((p) => (
              <Link key={p.id} href={href(p.id, n)}
                className={`chip ${p.id === partnerId ? "!bg-brand !text-white" : ""}`}>{p.name}</Link>
            ))}
            <span className="mx-1 text-slate-300">|</span>
            {RANGES.map((r) => (
              <Link key={r} href={href(partnerId, r)} className={`chip ${r === n ? "!bg-slate-800 !text-white" : ""}`}>{r} เดือน</Link>
            ))}
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <Kpi label={`ยอดขายรวม ${n} เดือน`} value={`฿${fmtMoney(a.totals.sales)}`} />
            <Kpi label="ส่วนแบ่ง (GP) ตามขั้นบันได" value={`฿${fmtMoney(a.totals.tierGP)}`} sub={`เฉลี่ย ${pct(a.totals.gpPct)} ของยอดขาย`} />
            <Kpi label="เฉลี่ยต่อวันที่ขาย" value={`฿${fmtMoney(a.totals.avgPerDay)}`} sub={`${a.totals.activeDays} วันที่มียอด`} />
            <Kpi label="ยอดตกสำรวจ" value={`฿${fmtMoney(a.totals.catchup)}`} sub={`${pct(a.totals.catchupPct)} ของยอดขาย`} warn={a.totals.catchupPct > 0.05} />
          </div>

          {(a.tier || a.pace) && (
            <div className="card space-y-1 text-sm">
              <h2 className="font-bold text-slate-800">เดือนนี้อยู่ตรงไหนของขั้นบันได</h2>
              {a.tier && (
                <p className="text-slate-700">
                  {ymLabel(a.tier.ym)} ขายได้ <b>฿{fmtMoney(a.tier.sales)}</b> ตอนนี้ส่วนแบ่ง <b>{pct(a.tier.currentRate, 0)}</b>
                  {a.tier.nextFrom != null && a.tier.remaining != null
                    ? <> · อีก <b>฿{fmtMoney(a.tier.remaining)}</b> จะถึงขั้นถัดไป ({pct(a.tier.nextRate ?? 0, 0)} เมื่อเกิน ฿{fmtMoney(a.tier.nextFrom)})</>
                    : <> · อยู่ขั้นสูงสุดแล้ว</>}
                </p>
              )}
              {a.pace && (
                <p className="text-slate-600">
                  ถ้าขายเท่าเดิมต่อวัน (ผ่านมา {a.pace.throughDay}/{a.pace.daysInMonth} วัน) ทั้งเดือนจะได้ราว <b>฿{fmtMoney(a.pace.projected)}</b> · ส่วนแบ่งประมาณ ฿{fmtMoney(a.pace.projectedGP)}
                  <span className="text-[11px] text-slate-400"> (คาดการณ์แบบเฉลี่ยรายวัน ไม่รวมช่วงวันหยุดพิเศษ)</span>
                </p>
              )}
            </div>
          )}

          <MonthsCard months={a.months} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card space-y-2">
              <h2 className="font-bold text-slate-800">หมวดที่ขายดี</h2>
              {a.categories.length === 0 ? (
                <p className="text-sm text-slate-400">ยังไม่มียอดรายหมวดจาก ANALYTICA ในช่วงนี้ (ต้องนำเข้าไฟล์ Overview รายวัน และตั้งหมวดของคู่ค้าไว้)</p>
              ) : a.categories.slice(0, 10).map((c) => (
                <Bar key={c.name} label={c.name} value={c.sales} frac={c.sharePct} right={`฿${fmtMoney(c.sales)} · ${pct(c.sharePct, 0)}`} />
              ))}
            </div>
            <div className="card space-y-2">
              <h2 className="font-bold text-slate-800">ขายดีวันไหนของสัปดาห์</h2>
              {(() => {
                const max = Math.max(...a.weekdays.map((w) => w.avg), 1);
                return a.weekdays.map((w) => (
                  <Bar key={w.dow} label={w.label} value={w.avg} frac={w.avg / max} right={w.days ? `฿${fmtMoney(w.avg)} · ${w.days} วัน` : "—"} />
                ));
              })()}
              <p className="text-[11px] text-slate-400">เฉลี่ยจากวันที่มียอดในช่วงที่เลือก (เฉพาะรอบรายวัน)</p>
            </div>
          </div>

          {a.bestDays.length > 0 && (
            <div className="card space-y-1">
              <h2 className="font-bold text-slate-800">วันที่ขายดีที่สุด</h2>
              <ol className="text-sm divide-y divide-slate-100">
                {a.bestDays.map((d, i) => (
                  <li key={d.date} className="flex items-center justify-between py-1.5">
                    <span className="text-slate-700">{i + 1}. {d.date.slice(8)} {TH_MONTHS_FULL[Number(d.date.slice(5, 7)) - 1]} {Number(d.date.slice(0, 4)) + 543}</span>
                    <span className="font-mono text-slate-800">฿{fmtMoney(d.sales)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <p className="text-[11px] text-slate-400">
            ส่วนแบ่งในหน้านี้คำนวณตามขั้นบันไดจากยอดขายของแต่ละเดือนเอง ยังไม่รวมยอดขั้นต่ำของใบวางบิลและส่วนต่างที่ต้องเรียกเก็บเพิ่ม
            (ดูตัวเลขจริงในคอลัมน์ "ใบวางบิล") · ใช้ติดตามภายในเท่านั้น
          </p>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${warn ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-lg font-bold text-slate-800">{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

function Bar({ label, frac, right }: { label: string; value: number; frac: number; right: string }) {
  const w = Math.max(2, Math.min(100, Math.round(frac * 100)));
  return (
    <div className="text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-slate-700 truncate">{label}</span>
        <span className="text-xs text-slate-500 shrink-0">{right}</span>
      </div>
      <div className="mt-0.5 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand" style={{ width: `${w}%` }} /></div>
    </div>
  );
}

function MonthsCard({ months }: { months: MonthRow[] }) {
  const max = Math.max(...months.map((m) => m.sales), 1);
  return (
    <div className="card space-y-2">
      <h2 className="font-bold text-slate-800">รายเดือน</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[40rem]">
          <thead>
            <tr className="text-xs text-slate-400 border-b border-slate-100">
              <th className="text-left py-1.5 font-normal">เดือน</th>
              <th className="text-left py-1.5 font-normal w-1/4"> </th>
              <th className="text-right py-1.5 font-normal">ยอดขาย</th>
              <th className="text-right py-1.5 font-normal">เทียบเดือนก่อน</th>
              <th className="text-right py-1.5 font-normal">GP ตามขั้น</th>
              <th className="text-right py-1.5 font-normal">GP %</th>
              <th className="text-right py-1.5 font-normal">ใบวางบิล</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.ym} className="border-b border-slate-50">
                <td className="py-1.5 text-slate-700 whitespace-nowrap">{ymLabel(m.ym)}</td>
                <td className="py-1.5 pr-3">
                  <div className="h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand" style={{ width: `${m.sales > 0 ? Math.max(2, Math.round(m.sales / max * 100)) : 0}%` }} /></div>
                </td>
                <td className="py-1.5 text-right font-mono text-slate-800">฿{fmtMoney(m.sales)}{m.catchup > 0 && <span className="block text-[10px] text-amber-600">รวมตกสำรวจ ฿{fmtMoney(m.catchup)}</span>}</td>
                <td className={`py-1.5 text-right ${m.momPct == null ? "text-slate-300" : m.momPct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {m.momPct == null ? "—" : `${m.momPct >= 0 ? "+" : ""}${(m.momPct * 100).toFixed(0)}%`}
                </td>
                <td className="py-1.5 text-right font-mono text-slate-800">฿{fmtMoney(m.tierGP)}</td>
                <td className="py-1.5 text-right text-slate-600">{m.sales > 0 ? pct(m.gpPct) : "—"}</td>
                <td className="py-1.5 text-right text-xs">
                  {m.settlement
                    ? <span className="text-slate-700">฿{fmtMoney(m.settlement.billedGP)}<span className="block text-[10px] text-slate-400">{SETTLE_TH[m.settlement.status]}</span></span>
                    : <span className="text-slate-300">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
