// /admin/persona/service-charge/company — company-wide Service Charge (owner
// 2026-08-18). One page for the whole company: branches pay out the same day, so
// the owner wants a combined total with a per-branch split for anyone who worked
// more than one branch ("ได้จากสาขาไหนเท่าไหร่"). A per-month "รวมกอง" toggle pools
// every branch's SVC and splits it by hours across everyone who worked that day —
// so a worker at a branch that entered no SVC (a new HYPO) still gets a share.

import { Fragment } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fmtMoney } from "@/lib/format";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import {
  computeCompanySvcSummary,
  isSharedSvcMonth,
  isManualSvcMonth,
  SVC_STAFF_SHARE_RATIO,
  SVC_COMPANY_SHARE_RATIO
} from "@/lib/service-charge";
import SharedPoolToggle from "./SharedPoolToggle";
import CompanySvcCalcModal from "./CompanySvcCalcModal";
import SvcForfeitExemptButton from "../SvcForfeitExemptButton";
import OwlMascot from "../../../../components/OwlMascot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Service Charge · รวมทั้งบริษัท · PERSONA" };

export default function CompanyServiceChargePage({
  searchParams
}: {
  searchParams: { month?: string };
}) {
  const user = requireAdmin();
  const lang = getLang();

  if (!user.activeBranchId) {
    return (
      <div className="card text-sm text-slate-600">
        {t(lang, "admin.notAssignedBranch")}
      </div>
    );
  }

  const db = getDb();
  const branchRow = db.prepare("SELECT id, name, company_id FROM branches WHERE id = ?")
    .get(user.activeBranchId) as { id: number; name: string; company_id: number | null } | undefined;
  if (!branchRow?.company_id) {
    return (
      <div className="card text-sm text-slate-600">
        สาขานี้ยังไม่ได้ผูกกับบริษัท — ตั้งค่าบริษัทของสาขาก่อนที่ /admin/companies
      </div>
    );
  }
  const company = db.prepare("SELECT id, name_th FROM companies WHERE id = ?")
    .get(branchRow.company_id) as { id: number; name_th: string } | undefined;

  // Default month = current Bangkok month
  const nowBkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const currentMonth = nowBkk.toISOString().slice(0, 7);
  const month = searchParams.month || currentMonth;

  const summary = computeCompanySvcSummary(branchRow.company_id, month);
  const shared = isSharedSvcMonth(branchRow.company_id, month);
  const manual = isManualSvcMonth(month);
  const canManagePayout = userCanViewPayroll(user);

  // 12-month picker
  const monthOptions: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(nowBkk.getUTCFullYear(), nowBkk.getUTCMonth() - i, 1));
    monthOptions.push(d.toISOString().slice(0, 7));
  }

  // Group FT first, then PT, then others; sso before wht within a group.
  const typeRank = (ty: string | null) => (ty === "ft" ? 0 : ty === "pt" ? 1 : 2);
  const taxRank = (m: string) => (m === "wht" ? 1 : 0);
  const distGroups = (["ft", "pt", "other"] as const)
    .map((key) => ({
      key,
      label: key === "ft" ? "พนักงานประจำ" : key === "pt" ? "พนักงานพาร์ทไทม์" : "อื่นๆ",
      rows: summary.rows
        .filter((r) => (key === "other" ? typeRank(r.employmentType) === 2 : r.employmentType === key))
        .slice()
        .sort((a, b) => taxRank(a.taxMode) - taxRank(b.taxMode))
    }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            เซอร์วิสชาร์จ · รวมทั้งบริษัท
            <span className="ml-2 text-sm font-medium text-brand">· {company?.name_th ?? ""}</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            สรุปยอดรวมทุกสาขา จ่ายพร้อมกันวันเดียว · แยกให้เห็นว่าใครได้จากสาขาไหนเท่าไหร่
          </p>
        </div>
        <Link
          href={`/admin/persona/service-charge?month=${month}`}
          className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 whitespace-nowrap"
        >
          ← ดูรายสาขา ({branchRow.name})
        </Link>
      </div>

      {/* Month picker */}
      <div className="card flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-slate-700">
          {t(lang, "admin.persona.svc.month")}:
        </span>
        {monthOptions.map((m) => (
          <Link
            key={m}
            href={`/admin/persona/service-charge/company?month=${m}`}
            className={`text-xs px-2.5 py-1 rounded border ${
              m === month
                ? "bg-brand text-white border-brand"
                : "border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {m}
          </Link>
        ))}
      </div>

      {/* รวมกอง toggle — computed months only (manual months have no hours to split) */}
      {!manual && (
        <SharedPoolToggle yearMonth={month} shared={shared} canEdit={canManagePayout} />
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <SummaryCard
          label="ยอด SVC รวมทุกสาขา"
          value={fmtMoney(summary.totalCollected)}
        />
        <SummaryCard
          label="ส่วนของพนักงาน"
          value={fmtMoney(summary.staffPoolTotal)}
          sub={`${Math.round(SVC_STAFF_SHARE_RATIO * 100)}% ของยอดรวม`}
        />
        <SummaryCard
          label="ส่วนของบริษัท"
          value={fmtMoney(summary.companyPoolTotal)}
          sub={`${Math.round(SVC_COMPANY_SHARE_RATIO * 100)}% + ที่ถูกตัดสิทธิ์`}
        />
        <SummaryCard
          label="ยอดจ่ายจริง (สุทธิ)"
          value={fmtMoney(summary.totalNetPayout)}
          accent="emerald"
          sub={summary.totalWht > 0 ? `หัก ณ ที่จ่ายรวม ${fmtMoney(summary.totalWht)}` : undefined}
        />
        <SummaryCard
          label="วันจ่าย"
          value={summary.payoutDate}
          accent="brand"
          sub="จ่ายพร้อมกันทุกสาขา"
        />
      </div>

      {/* Per-branch collected */}
      <div className="card">
        <div className="text-xs font-bold text-slate-600 mb-2">ยอด SVC ที่เก็บได้ · แยกตามสาขา</div>
        <div className="flex flex-wrap gap-2">
          {summary.branches.map((b) => (
            <div key={b.branchId} className="rounded-lg border border-slate-200 px-3 py-1.5">
              <div className="text-[11px] text-slate-500">{b.branchName}</div>
              <div className="text-sm font-bold text-slate-800">{fmtMoney(b.totalCollected)}</div>
            </div>
          ))}
          {summary.branches.length === 0 && (
            <div className="text-sm text-slate-400">ยังไม่มีสาขาในบริษัทนี้</div>
          )}
        </div>
        {shared && (
          <div className="text-[11px] text-brand mt-2 font-medium">
            โหมดรวมกองเปิดอยู่ — ยอดทุกสาขาถูกรวมแล้วแบ่งตามชั่วโมงทำงานจริงให้ทุกคน
          </div>
        )}
        {summary.totalGroupInsurance > 0 && (
          <div className="text-[11px] text-slate-500 mt-2">
            หักประกันกลุ่มรวม {fmtMoney(summary.totalGroupInsurance)} บาท (พนักงานใหม่ในช่วง ·
            ตั้งเป็นเจ้าหนี้รอนำส่งบริษัทประกัน)
          </div>
        )}
      </div>

      {/* Distribution */}
      <div className="card">
        <h2 className="font-bold text-slate-800 text-sm mb-3">
          ส่วนแบ่งพนักงาน · ทั้งบริษัท
        </h2>
        {summary.rows.length === 0 ? (
          <div className="text-center py-10">
            <OwlMascot size={80} mood="thinking" />
            <p className="text-sm text-slate-400 mt-3">
              {manual
                ? "เดือนก่อนเริ่มใช้ระบบ — ดู/กรอกยอดที่หน้ารายสาขา"
                : "ยังไม่มีข้อมูลส่วนแบ่งในเดือนนี้"}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3">ชื่อ</th>
                  <th className="py-2 pr-3">ได้จากสาขา</th>
                  <th className="py-2 pr-3 text-right">ชั่วโมง</th>
                  <th className="py-2 pr-3 text-right">สาย</th>
                  <th className="py-2 pr-3 text-right">รวม</th>
                  <th className="py-2 pr-3 text-right">สุทธิ</th>
                  <th className="py-2 pr-3">สถานะ</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {distGroups.map((g) => (
                  <Fragment key={g.key}>
                    <tr className="bg-slate-50">
                      <td colSpan={8} className="py-1.5 px-2 text-xs font-bold text-slate-600">
                        {g.label} ({g.rows.length} คน)
                      </td>
                    </tr>
                    {g.rows.map((r) => {
                      const hours = (r.byBranch.reduce((s, b) => s + b.minutesWorked, 0) / 60).toFixed(1);
                      const latePct = (r.lateRatio * 100).toFixed(1);
                      return (
                        <tr key={r.userId} className="border-b border-slate-100 align-top">
                          <td className="py-2 pr-3">
                            <div className="font-medium text-slate-800 flex items-center gap-1.5 flex-wrap">
                              <span>{r.displayName}</span>
                              {r.taxMode === "wht" && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                                  หัก ณ ที่จ่าย
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-2 pr-3">
                            <div className="flex flex-wrap gap-1">
                              {r.byBranch.map((b) => (
                                <span key={b.branchId}
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 whitespace-nowrap">
                                  {b.branchName} ฿{fmtMoney(b.grossAllocation)}
                                </span>
                              ))}
                              {r.byBranch.length === 0 && <span className="text-[10px] text-slate-400">—</span>}
                            </div>
                          </td>
                          <td className="py-2 pr-3 text-right text-slate-600">{hours}</td>
                          <td className="py-2 pr-3 text-right text-slate-500">
                            {r.lateMinutes > 0 ? `${latePct}%` : "—"}
                          </td>
                          <td className="py-2 pr-3 text-right">{fmtMoney(r.grossAllocation)}</td>
                          <td className={`py-2 pr-3 text-right font-bold ${
                            r.forfeited ? "text-rose-500 line-through" : "text-emerald-700"
                          }`}>
                            {fmtMoney(r.netPayout)}
                            {!r.forfeited && r.taxMode === "wht" && (
                              <span className="block text-[9px] font-normal text-rose-500">หัก ณ ที่จ่าย 3%</span>
                            )}
                          </td>
                          <td className="py-2 pr-3">
                            {r.exempted ? (
                              <SvcForfeitExemptButton userId={r.userId} yearMonth={month}
                                forfeited={false} exempted reason={r.exemptReason}
                                canEdit={canManagePayout} />
                            ) : r.forfeited ? (
                              <div className="flex flex-col items-start gap-1">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                                  r.forfeitReason === "late_20pct" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"
                                }`}>
                                  ✗ {r.forfeitReason === "late_20pct" ? "สายเกิน 20%" : "ลาออก"}
                                </span>
                                <SvcForfeitExemptButton userId={r.userId} yearMonth={month}
                                  forfeited exempted={false} reason={r.forfeitReason}
                                  canEdit={canManagePayout} />
                              </div>
                            ) : (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold">
                                ✓ ได้รับ
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right">
                            <CompanySvcCalcModal
                              displayName={r.displayName}
                              shared={summary.shared}
                              byBranch={r.byBranch}
                              grossAllocation={r.grossAllocation}
                              netAllocation={r.netAllocation}
                              forfeited={r.forfeited}
                              forfeitReason={r.forfeitReason}
                              dailyBreakdown={r.dailyBreakdown}
                              taxMode={r.taxMode}
                              whtAmount={r.whtAmount}
                              groupInsurance={r.groupInsurance}
                              netPayout={r.netPayout}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-medium">
                  <td className="py-2 pr-3" colSpan={4}>รวมทั้งหมด ({summary.rows.length} คน)</td>
                  <td className="py-2 pr-3 text-right">
                    {fmtMoney(summary.rows.reduce((s, r) => s + r.grossAllocation, 0))}
                  </td>
                  <td className="py-2 pr-3 text-right text-emerald-700">
                    {fmtMoney(summary.totalNetPayout)}
                    {summary.totalWht > 0 && (
                      <span className="block text-[9px] font-normal text-rose-500">
                        หัก ณ ที่จ่ายรวม {fmtMoney(summary.totalWht)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3"></td>
                  <td className="py-2 pr-3"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Rule key */}
      <div className="card text-xs text-slate-500 space-y-1">
        <div className="font-bold text-slate-700 uppercase tracking-[0.5px] text-[10px] mb-1">
          กติกา
        </div>
        <div>· แบ่ง 60% พนักงาน / 40% บริษัท · ส่วนพนักงานแบ่งตามชั่วโมงทำงานจริง</div>
        <div>· ยอดสุทธิ = ส่วนแบ่ง − ค่าอาหารที่กลับก่อนครบกะ − ภาษี ณ ที่จ่าย 3% (เฉพาะกลุ่มหักภาษี) − ประกันกลุ่ม (พนักงานใหม่)</div>
        <div>· สายเกิน 20% ของเวลาทำงานทั้งเดือน (รวมทุกสาขา) หรือ ลาออกแบบตัดสิทธิ์ → ยอดเป็น 0</div>
        <div>· รวมกอง (ถ้าเปิด): เอายอดทุกสาขามารวมกัน แบ่งให้ทุกคนที่ทำงานวันนั้นตามชั่วโมง — คนที่ทำสาขายังไม่มียอดก็ได้ส่วนแบ่ง</div>
        <div>· วันจ่าย: วันที่ 20 ของเดือนถัดไป · จ่ายพร้อมกันทุกสาขา</div>
      </div>
    </div>
  );
}

function SummaryCard({
  label, value, sub, accent
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "emerald" | "amber" | "rose" | "brand";
}) {
  const valueCls =
    accent === "emerald" ? "text-emerald-700" :
    accent === "amber"   ? "text-amber-600" :
    accent === "rose"    ? "text-rose-600" :
    accent === "brand"   ? "text-brand" :
    "text-slate-800";
  return (
    <div className="card">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${valueCls}`}>{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}
