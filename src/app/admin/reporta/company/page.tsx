import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission, canModule } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { companyOverview, companyWeekCompare, annualBranchBars, festivalAnalysis, companyTopMenu } from "@/lib/salesa-analytics";
import { fmtMoney } from "@/lib/format";
import CompanyReportActions from "./CompanyReportActions";

// ANALYTICA · ภาพรวมบริษัท (รวมทุกสาขา) — owner 2026-09-21. ยอดขายรวมบริษัท +
// เทียบรายสาขา + เทียบเดือนนี้↔เดือนก่อน (ช่วงเวลาเดียวกัน) + เป้าเดือน/ทั้งปี.
// บริษัท = บริษัทของสาขาที่เลือกอยู่ (activeBranchId → branches.company_id).
// เห็นได้ตามสิทธิ์ reporta.manage (ผู้ดูแลระบบ / HOD ที่ได้สิทธิ์).

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ANALYTICA · ภาพรวมบริษัท (รวมสาขา)" };

const TH_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
function todayBkk(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}
function shiftMonth(year: number, month: number, delta: number): { y: number; m: number } {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}
const baht = (n: number) => fmtMoney(n);
function Pct({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-slate-300">—</span>;
  const cls = pct > 0 ? "text-emerald-600" : pct < 0 ? "text-rose-500" : "text-slate-400";
  return <span className={`font-medium ${cls}`}>{pct > 0 ? `▲ +${pct}` : pct < 0 ? `▼ ${pct}` : "± 0"}%</span>;
}

export default function ReportaCompanyPage({ searchParams }: { searchParams: { year?: string; month?: string } }) {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/reporta" className="text-sm text-slate-500 hover:text-brand">← กลับ ANALYTICA</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }
  const db = getDb();
  const companyId = (db.prepare("SELECT company_id FROM branches WHERE id = ?").get(branchId) as { company_id: number | null } | undefined)?.company_id ?? null;
  if (companyId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/reporta" className="text-sm text-slate-500 hover:text-brand">← กลับ ANALYTICA</Link>
        <div className="card text-sm text-slate-500">สาขานี้ยังไม่ได้ผูกกับบริษัท — ตั้งค่าบริษัทให้สาขาก่อน</div>
      </div>
    );
  }

  const today = todayBkk();
  const nowY = Number(today.slice(0, 4)), nowM = Number(today.slice(5, 7));
  const year = /^\d{4}$/.test(searchParams.year ?? "") ? Number(searchParams.year) : nowY;
  const month = /^([1-9]|1[0-2])$/.test(searchParams.month ?? "") ? Number(searchParams.month) : nowM;

  const companyBranchIds = (db.prepare("SELECT id FROM branches WHERE company_id = ?").all(companyId) as Array<{ id: number }>).map((b) => b.id);
  const ov = companyOverview(companyBranchIds, year, month, today);
  // Phase 2 (owner 2026-09-21): weekly same-period compare, full-year growth
  // bars and festival uplift — all company-scoped. Growth/festival are for the
  // current year regardless of the month picker (they're whole-year views).
  const wk = companyWeekCompare(companyBranchIds, today);
  const bars = annualBranchBars(year, today, companyBranchIds);
  const fest = festivalAnalysis(year, today, companyBranchIds);
  const thDate = (iso: string) => { const [, m, d] = iso.split("-").map(Number); return `${d} ${TH_MONTHS[m]}`; };
  // Top menu / categories รวมทุกสาขา. Window = 1..today for the current month, the
  // FULL month for a past month (matches the per-branch monthly view, and doesn't
  // depend on daily has_sales — a menu-only import still shows).
  const mmp = String(month).padStart(2, "0");
  const isCurMonth = year === nowY && month === nowM;
  const menuDay = isCurMonth ? Number(today.slice(8, 10)) : new Date(Date.UTC(year, month, 0)).getUTCDate();
  const menu = companyTopMenu(companyBranchIds, `${year}-${mmp}-01`, `${year}-${mmp}-${String(menuDay).padStart(2, "0")}`);

  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  const isFuture = next.y > nowY || (next.y === nowY && next.m > nowM);
  const href = (y: number, m: number) => `/admin/reporta/company?year=${y}&month=${m}`;
  const maxMtd = Math.max(1, ...ov.branches.map((b) => b.mtdNett));
  const t = ov.total;

  return (
    // Centered reading width on desktop, full width on mobile (owner 2026-09-22).
    <div className="space-y-4 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/reporta" className="text-sm text-slate-500 hover:text-brand">← กลับ ANALYTICA (รายสาขา)</Link>
        {canModule(user, "accounta.manage") && (
          <Link href="/admin/accounta/company" className="text-sm text-brand hover:underline">โครงสร้างต้นทุน · กฎ 100% (ACCOUNTA รวมบริษัท) →</Link>
        )}
      </div>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">ภาพรวมบริษัท · รวมทุกสาขา</h1>
          <p className="text-sm text-slate-500 mt-1">ยอดขายรวมบริษัท เทียบรายสาขา และเทียบเดือนนี้กับเดือนก่อนในช่วงเวลาเดียวกัน</p>
        </div>
        {ov.branchCount > 0 && <CompanyReportActions year={year} month={month} />}
      </div>

      {/* Month switcher */}
      <div className="flex items-center gap-2">
        <Link href={href(prev.y, prev.m)} className="btn-secondary text-sm px-3 py-1.5" aria-label="เดือนก่อน">‹</Link>
        <div className="text-center min-w-[9rem]">
          <div className="text-[10px] uppercase tracking-[1.5px] text-slate-400">เดือน</div>
          <div className="font-bold text-slate-800">{TH_MONTHS[month]} {year + 543}</div>
        </div>
        {isFuture
          ? <span className="btn-secondary text-sm px-3 py-1.5 opacity-30 cursor-not-allowed">›</span>
          : <Link href={href(next.y, next.m)} className="btn-secondary text-sm px-3 py-1.5" aria-label="เดือนถัดไป">›</Link>}
        {(year !== nowY || month !== nowM) && <Link href={href(nowY, nowM)} className="text-sm text-brand hover:underline ml-1">เดือนนี้</Link>}
      </div>

      {ov.branchCount === 0 ? (
        <div className="card text-sm text-slate-400">ยังไม่มีสาขาในบริษัทนี้</div>
      ) : (
        <>
          {/* Company KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card">
              <div className="text-xs text-slate-500">ยอดขายรวม (วันที่ 1–{ov.throughDay})</div>
              <div className="text-xl font-bold text-slate-800 tabular-nums">฿{baht(t.mtdNett)}</div>
              <div className="text-[11px] mt-0.5">เทียบเดือนก่อน <Pct pct={t.momPct} />{t.prevSameNett != null ? <span className="text-slate-400"> (฿{baht(t.prevSameNett)})</span> : null}</div>
            </div>
            {ov.isCurrentMonth && (
              <div className="card">
                <div className="text-xs text-slate-500">ยอดขายวันนี้ (รวมสาขา)</div>
                <div className="text-xl font-bold text-slate-800 tabular-nums">฿{baht(t.todayNett ?? 0)}</div>
              </div>
            )}
            <div className="card">
              <div className="text-xs text-slate-500">จำนวนบิลรวม</div>
              <div className="text-xl font-bold text-slate-800 tabular-nums">{t.bills.toLocaleString("th-TH")}</div>
            </div>
            <div className="card">
              <div className="text-xs text-slate-500">ลูกค้ารวม</div>
              <div className="text-xl font-bold text-slate-800 tabular-nums">{t.pax.toLocaleString("th-TH")}</div>
            </div>
          </div>
          <p className="text-[11px] text-slate-400 -mt-1">เทียบวันที่ 1–{ov.throughDay} ของเดือนนี้ กับ 1–{ov.throughDay} ของเดือนก่อน (ช่วงเวลาเดียวกัน) · % เทียบเฉพาะสาขาที่มีข้อมูลทั้งสองเดือน (ไม่รวมสาขาเปิดใหม่)</p>

          {/* Company monthly target */}
          {ov.target && (
            <div className="card space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-slate-500">เป้ารายเดือนรวม ({ov.targetedBranchCount} สาขาที่ตั้งเป้า) · ฿{baht(ov.target.target)}</span>
                <span className={`font-bold ${ov.target.pctOfTarget >= 100 ? "text-emerald-600" : "text-slate-700"}`}>{ov.target.pctOfTarget.toFixed(0)}% ของเป้า</span>
              </div>
              <div className="h-2.5 rounded-full bg-slate-200 overflow-hidden">
                <div className={`h-full ${ov.target.pctOfTarget >= 100 ? "bg-emerald-500" : "bg-emerald-400"}`} style={{ width: `${Math.min(100, ov.target.pctOfTarget)}%` }} />
              </div>
              <div className="text-[11px] text-slate-500">คาดสิ้นเดือน <b className={ov.target.onTrack ? "text-emerald-600" : "text-amber-600"}>฿{baht(ov.target.projectedNett)}</b> ({ov.target.projectedPct.toFixed(0)}% ของเป้า) · {ov.target.onTrack ? "มีแนวโน้มถึงเป้า ✓" : "ต่ำกว่าเป้า ต้องเร่ง"}</div>
            </div>
          )}

          {/* Company annual roll-up */}
          {ov.annual && (
            <div className="card space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-slate-500">เป้าทั้งปี {ov.annual.year + 543} รวมบริษัท · ฿{baht(ov.annual.annualTarget)}</span>
                <span className={`font-bold ${ov.annual.pctOfTarget >= 100 ? "text-emerald-600" : "text-slate-700"}`}>{ov.annual.pctOfTarget.toFixed(0)}% ของเป้า</span>
              </div>
              {ov.annual.prorated && <div className="text-[11px] text-slate-400">สาขาที่เพิ่งเปิดปีนี้คิดเป้าตามวันที่เปิดจริง (เต็มปีทุกสาขา ฿{baht(ov.annual.fullYearTarget)})</div>}
              <div className="h-2.5 rounded-full bg-slate-200 overflow-hidden">
                <div className={`h-full ${ov.annual.pctOfTarget >= 100 ? "bg-emerald-500" : "bg-emerald-400"}`} style={{ width: `${Math.min(100, ov.annual.pctOfTarget)}%` }} />
              </div>
              <div className="text-[11px] text-slate-500">YTD ฿{baht(ov.annual.ytdNett)} · คาดสิ้นปี <b className={ov.annual.onTrack ? "text-emerald-600" : "text-amber-600"}>฿{baht(ov.annual.projectedNett)}</b> ({ov.annual.projectedPct.toFixed(0)}% ของเป้า)</div>
            </div>
          )}

          {/* Per-branch table */}
          <div className="card">
            <div className="text-sm font-bold text-slate-800 mb-2">เทียบรายสาขา (วันที่ 1–{ov.throughDay})</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-[11px] text-slate-400 border-b border-slate-200">
                    <th className="text-left py-1.5 pr-2">สาขา</th>
                    <th className="text-right py-1.5 px-2">ยอดขาย</th>
                    <th className="text-right py-1.5 px-2">เทียบเดือนก่อน</th>
                    <th className="text-right py-1.5 px-2">เป้าเดือน</th>
                    <th className="text-right py-1.5 px-2">ทำได้</th>
                    {ov.isCurrentMonth && <th className="text-right py-1.5 px-2">วันนี้</th>}
                    <th className="text-right py-1.5 pl-2">บิล</th>
                  </tr>
                </thead>
                <tbody>
                  {ov.branches.map((b) => (
                    <tr key={b.branchId} className="border-b border-slate-50 align-top">
                      <td className="py-2 pr-2">
                        <div className="font-medium text-slate-700">{b.branchName}</div>
                        <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden mt-1 w-28">
                          <div className="h-full bg-emerald-400 rounded-full" style={{ width: `${Math.max(2, (b.mtdNett / maxMtd) * 100)}%` }} />
                        </div>
                      </td>
                      <td className="py-2 px-2 text-right font-semibold text-slate-700">฿{baht(b.mtdNett)}</td>
                      <td className="py-2 px-2 text-right"><Pct pct={b.momPct} /></td>
                      <td className="py-2 px-2 text-right text-slate-500">{b.monthTarget != null ? `฿${baht(b.monthTarget)}` : "—"}</td>
                      <td className="py-2 px-2 text-right text-slate-500">{b.pctOfTarget != null ? `${b.pctOfTarget.toFixed(0)}%` : "—"}</td>
                      {ov.isCurrentMonth && <td className="py-2 px-2 text-right text-slate-500">{b.todayNett != null ? `฿${baht(b.todayNett)}` : "—"}</td>}
                      <td className="py-2 pl-2 text-right text-slate-500">{b.bills.toLocaleString("th-TH")}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 font-bold">
                    <td className="py-2 pr-2">รวมบริษัท</td>
                    <td className="py-2 px-2 text-right">฿{baht(t.mtdNett)}</td>
                    <td className="py-2 px-2 text-right"><Pct pct={t.momPct} /></td>
                    <td className="py-2 px-2 text-right text-slate-500">{ov.target ? `฿${baht(ov.target.target)}` : "—"}</td>
                    <td className="py-2 px-2 text-right text-slate-500">{ov.target ? `${ov.target.pctOfTarget.toFixed(0)}%` : "—"}</td>
                    {ov.isCurrentMonth && <td className="py-2 px-2 text-right text-slate-500">฿{baht(t.todayNett ?? 0)}</td>}
                    <td className="py-2 pl-2 text-right text-slate-500">{t.bills.toLocaleString("th-TH")}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="text-[11px] text-slate-400 mt-2">
              ทำได้ = ยอดขายสะสมถึงวันที่ {ov.throughDay} ÷ เป้าทั้งเดือน
              {ov.target ? ` · แถวรวม “ทำได้” นับเฉพาะ ${ov.targetedBranchCount} สาขาที่ตั้งเป้า (฿${baht(ov.target.mtdNett)} ÷ ฿${baht(ov.target.target)})` : ""}
            </p>
          </div>

          {/* Weekly same-period compare (owner 2026-09-21) */}
          {wk.branches.length > 0 && (
          <div className="card space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-sm font-bold text-slate-800">สัปดาห์นี้ เทียบสัปดาห์ก่อน (ช่วงเวลาเดียวกัน)</div>
              <div className="text-[11px] text-slate-400">{thDate(wk.weekStart)}–{thDate(wk.throughIso)} · {wk.dayCount} วัน</div>
            </div>
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-xl font-bold text-slate-800 tabular-nums">฿{baht(wk.total.nett)}</span>
              <span className="text-sm"><Pct pct={wk.total.wowPct} /></span>
              {wk.total.prevNett != null && <span className="text-[11px] text-slate-400">สัปดาห์ก่อน ฿{baht(wk.total.prevNett)}</span>}
              <span className="text-[11px] text-slate-400">· {wk.total.bills.toLocaleString("th-TH")} บิล · {wk.total.pax.toLocaleString("th-TH")} คน</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead><tr className="text-[11px] text-slate-400 border-b border-slate-200">
                  <th className="text-left py-1.5 pr-2">สาขา</th><th className="text-right py-1.5 px-2">สัปดาห์นี้</th>
                  <th className="text-right py-1.5 px-2">สัปดาห์ก่อน</th><th className="text-right py-1.5 pl-2">เทียบ</th>
                </tr></thead>
                <tbody>
                  {wk.branches.map((b) => (
                    <tr key={b.branchId} className="border-b border-slate-50">
                      <td className="py-1.5 pr-2 text-slate-700">{b.branchName}</td>
                      <td className="py-1.5 px-2 text-right font-semibold text-slate-700">฿{baht(b.nett)}</td>
                      <td className="py-1.5 px-2 text-right text-slate-500">{b.prevNett != null ? `฿${baht(b.prevNett)}` : "—"}</td>
                      <td className="py-1.5 pl-2 text-right"><Pct pct={b.wowPct} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-400">% รวมเทียบเฉพาะสาขาที่มีข้อมูลทั้งสองสัปดาห์ · แสดงเฉพาะสาขาที่มียอดขายในสัปดาห์ที่เทียบ</p>
          </div>
          )}

          {/* Full-year growth bars per branch (owner 2026-09-21), company-scoped */}
          {bars.branches.length > 0 && (
            <div className="card space-y-3">
              <div className="text-sm font-bold text-slate-800">เทรนด์การเติบโตทั้งปี {year + 543} — รายเดือนแต่ละสาขา</div>
              {bars.branches.map((b) => {
                const peak = Math.max(1, ...b.months.map((v) => v ?? 0));
                return (
                  <div key={b.branchId}>
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <span className="text-sm font-semibold text-slate-800">{b.branchName}</span>
                      <span className="text-xs text-slate-500">รวม ฿{baht(b.total)}{b.growthPct != null && <span className="ml-2"><Pct pct={b.growthPct} /></span>}</span>
                    </div>
                    <div className="flex items-end gap-1 h-20">
                      {b.months.map((v, i) => (
                        <div key={i} className="flex-1 flex flex-col items-center justify-end h-full" title={`${TH_MONTHS[i + 1]}: ${v == null ? "ไม่มีข้อมูล" : `฿${baht(v)}`}`}>
                          <div className={`w-full rounded-t ${b.peakMonth === i + 1 ? "bg-emerald-500" : "bg-emerald-300"}`} style={{ height: v == null ? "0%" : `${Math.max(2, (v / peak) * 100)}%` }} />
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-1 mt-1">{b.months.map((_, i) => <div key={i} className="flex-1 text-center text-[9px] text-slate-400">{i + 1}</div>)}</div>
                  </div>
                );
              })}
              <p className="text-[11px] text-slate-400">แท่ง = ยอดขายสุทธิรายเดือน (เลข 1–12 = เดือน) · เขียวเข้ม = เดือนสูงสุด · % = เดือนแรก↔เดือนล่าสุดที่มีข้อมูล</p>
            </div>
          )}

          {/* Festival / important-day uplift (owner 2026-09-21), company-scoped */}
          {fest.rows.length > 0 && (
            <div className="card">
              <div className="text-sm font-bold text-slate-800 mb-2">วันสำคัญ / เทศกาล {year + 543} — เทียบยอดขายแต่ละสาขา</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead><tr className="text-[11px] text-slate-500 border-b border-slate-200">
                    <th className="text-left py-2 pr-3">วันสำคัญ</th>
                    {fest.branches.map((b) => <th key={b.id} className="text-right py-2 px-2 whitespace-nowrap">{b.name}</th>)}
                  </tr></thead>
                  <tbody>
                    {fest.rows.map((row) => (
                      <tr key={row.date} className="border-b border-slate-100 align-top">
                        <td className="py-2 pr-3"><div className="font-medium text-slate-800">{row.nameTh}</div><div className="text-[11px] text-slate-400">{row.dateLabel}</div></td>
                        {row.branches.map((c) => (
                          <td key={c.branchId} className="py-2 px-2 text-right">
                            {c.sales == null ? <span className="text-slate-300">—</span> : (
                              <>
                                <div className="font-semibold text-slate-700 tabular-nums">฿{baht(c.sales)}</div>
                                {c.upliftPct != null && <div className="text-[11px]"><Pct pct={c.upliftPct} /></div>}
                              </>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-slate-400 mt-2">▲/▼ = ยอดวันนั้นเทียบกับยอดขายเฉลี่ยต่อวันของสาขาในเดือนเดียวกัน</p>
            </div>
          )}

          {/* Top menu / categories รวมทุกสาขา (owner 2026-09-21) */}
          {(menu.items.length > 0 || menu.categories.length > 0) && (
            <div className="card">
              <div className="text-sm font-bold text-slate-800 mb-1">ขายดีรวมทุกสาขา — {TH_MONTHS[month]} {year + 543}{isCurMonth ? ` (วันที่ 1–${menuDay})` : ""}</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="text-xs font-semibold text-slate-500 mb-1">เมนูทำรายได้สูงสุด</div>
                  {menu.items.length === 0 ? <p className="text-xs text-slate-400">ยังไม่มีข้อมูลเมนู</p> : (
                    <div className="space-y-1">
                      {menu.items.map((it, i) => (
                        <div key={it.name} className="flex items-baseline justify-between gap-2 text-sm">
                          <span className="text-slate-700 truncate">{i + 1}. {it.name}{it.branchCount > 1 && <span className="text-[10px] text-slate-400 ml-1">({it.branchCount} สาขา)</span>}</span>
                          <span className="tabular-nums text-slate-600 whitespace-nowrap">฿{baht(it.nett)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-500 mb-1">หมวดทำรายได้สูงสุด</div>
                  {menu.categories.length === 0 ? <p className="text-xs text-slate-400">ยังไม่มีข้อมูลหมวด</p> : (
                    <div className="space-y-1">
                      {menu.categories.map((c, i) => (
                        <div key={c.name} className="flex items-baseline justify-between gap-2 text-sm">
                          <span className="text-slate-700 truncate">{i + 1}. {c.name}{c.branchCount > 1 && <span className="text-[10px] text-slate-400 ml-1">({c.branchCount} สาขา)</span>}</span>
                          <span className="tabular-nums text-slate-600 whitespace-nowrap">฿{baht(c.nett)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-slate-400 mt-2">ยอดขายสุทธิรวมทุกสาขาในบริษัท · แสดงสูงสุด 8 อันดับ · (N สาขา) = ขายที่กี่สาขา</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
