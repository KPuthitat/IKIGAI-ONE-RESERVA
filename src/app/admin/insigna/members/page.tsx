// /admin/insigna/members — members and how they visit (owner 2026-10-03).
//
// The corporate-customer questions asked of members: how often, how many
// times this year, which part of the month and weekday, near which holiday,
// spend so far, who has gone quiet, whose birthday is this month. Every row is
// a member code — no name exists anywhere in the system. requireAdmin gate.

import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { memberReport, ACQUISITION_SOURCES } from "@/lib/insigna";
import { formatLongDate } from "@/lib/time";
import { getLineGroupId } from "@/lib/salesa-db";
import { getMemberMessageConfig, memberPushTargets } from "@/lib/member-line";
import MemberSendPanel from "./MemberSendPanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สมาชิก · INSIGNA" };

const TH_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intTh = (n: number) => n.toLocaleString("th-TH");
const sourceLabel = (k: string | null) => k ? (ACQUISITION_SOURCES.find((s) => s.key === k)?.label ?? k) : null;
const genderTh = (g: "M" | "F" | "X" | null) => g === "F" ? "หญิง" : g === "M" ? "ชาย" : g === "X" ? "ไม่ระบุเพศ" : null;

export default function InsignaMembersPage({ searchParams }: { searchParams: { year?: string; branch?: string } }) {
  const user = requireAdmin();
  const todayIso = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const nowYear = Number(todayIso.slice(0, 4));
  const year = Number(searchParams.year) || nowYear;
  const branchId = Number(searchParams.branch) || null;
  const branches = getDb().prepare("SELECT id, name FROM branches ORDER BY name").all() as Array<{ id: number; name: string }>;
  const branchName = (id: number | null) => id ? (branches.find((b) => b.id === id)?.name ?? `#${id}`) : null;
  const r = memberReport({ year, todayIso, branchId });
  const qs = (y: number, b: number | null) => `/admin/insigna/members?year=${y}${b ? `&branch=${b}` : ""}`;
  const withVisits = r.rows.filter((m) => m.pattern);
  const noVisits = r.rows.filter((m) => !m.pattern);
  const monthPeak = Math.max(1, ...withVisits.flatMap((m) => m.pattern!.months));
  // Sends (phase 4): the report goes to the active branch's HOD group; member
  // messages reach consenting members not yet messaged in the guard window.
  const activeBranchId = user.activeBranchId ?? null;
  const hasGroup = activeBranchId != null && !!getLineGroupId(activeBranchId);
  const cfg = getMemberMessageConfig();
  const birthdayTargets = memberPushTargets(r, "birthday", todayIso).length;
  const winbackTargets = memberPushTargets(r, "winback", todayIso).length;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin/insigna" className="text-xs text-slate-400 hover:text-brand">← INSIGNA</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-1">สมาชิก · การมาใช้บริการ</h1>
        <p className="text-sm text-slate-500 mt-1">
          สมาชิกที่สมัครผ่าน LINE และบิลที่พนักงานบันทึกตอนชำระเงิน: มาบ่อยแค่ไหน ปีนี้กี่ครั้ง มักมาช่วงไหน ใกล้วันหยุดใด ยอดสะสม ใครเงียบไป และใครเกิดเดือนนี้ · ทุกแถวเป็นหมายเลขสมาชิก ไม่มีชื่อ
        </p>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-sm">
        <div className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50/60 p-1">
          <Link href={qs(year - 1, branchId)} className="px-2 text-slate-500 hover:text-slate-800">‹</Link>
          <span className="px-2 font-bold text-slate-800">ปี พ.ศ. {year + 543}</span>
          {year < nowYear ? <Link href={qs(year + 1, branchId)} className="px-2 text-slate-500 hover:text-slate-800">›</Link> : <span className="px-2 text-slate-300">›</span>}
        </div>
        <span className="text-xs text-slate-400">บิลที่:</span>
        <Link href={qs(year, null)} className={`px-2.5 py-1 rounded-full text-xs border ${!branchId ? "bg-brand text-white border-brand" : "bg-white text-slate-600 border-slate-200"}`}>ทุกสาขา</Link>
        {branches.map((b) => (
          <Link key={b.id} href={qs(year, b.id)} className={`px-2.5 py-1 rounded-full text-xs border ${branchId === b.id ? "bg-brand text-white border-brand" : "bg-white text-slate-600 border-slate-200"}`}>{b.name}</Link>
        ))}
        <span className="flex-1" />
        <Link href="/admin/insigna/members/qr" className="btn-secondary text-xs">QR สมัครสมาชิก</Link>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="card !p-3 bg-emerald-50 border-emerald-100">
          <div className="text-[11px] text-slate-500">สมาชิกทั้งหมด</div>
          <div className="text-xl font-bold text-slate-800 tabular-nums">{intTh(r.summary.members)}</div>
          <div className="text-[11px] text-slate-500">สมัครใหม่เดือนนี้ {intTh(r.summary.newThisMonth)} · ยินยอมรับข่าวสาร {intTh(r.summary.consented)}</div>
        </div>
        <div className="card !p-3">
          <div className="text-[11px] text-slate-500">มีประวัติบิล</div>
          <div className="text-xl font-bold text-slate-800 tabular-nums">{intTh(r.summary.withVisits)}</div>
          <div className="text-[11px] text-slate-500">ปี {year + 543} มารวม {intTh(r.summary.visitsYear)} ครั้ง</div>
        </div>
        <div className="card !p-3">
          <div className="text-[11px] text-slate-500">ยอดสมาชิกปีนี้ (จากบิลที่บันทึก)</div>
          <div className="text-xl font-bold text-slate-800 tabular-nums">{baht(r.summary.spendYear)}</div>
        </div>
        <div className="card !p-3">
          <div className="text-[11px] text-slate-500">เกิดเดือน{TH_MONTHS[r.month]}</div>
          <div className="text-xl font-bold text-slate-800 tabular-nums">{intTh(r.summary.birthdaysThisMonth)}</div>
          <div className="text-[11px] text-slate-500">เงียบนานกว่ารอบปกติ {intTh(r.summary.overdue)}</div>
        </div>
      </div>

      {(r.summary.members > 0) && (
        <div className="card text-xs text-slate-600 flex flex-wrap gap-x-4 gap-y-1">
          <span>เพศ: หญิง {r.summary.genders.F} · ชาย {r.summary.genders.M} · ไม่ระบุ {r.summary.genders.X + r.summary.genders.unknown}</span>
          {r.summary.sources.length > 0 && <span>รู้จักร้านจาก: {r.summary.sources.slice(0, 4).map((s) => `${sourceLabel(s.key)} ${s.n}`).join(" · ")}</span>}
          {r.summary.areas.length > 0 && <span>ย่านที่พัก: {r.summary.areas.slice(0, 5).map((a) => `${a.area} ${a.n}`).join(" · ")}</span>}
        </div>
      )}

      <MemberSendPanel year={year} branchId={branchId} hasGroup={hasGroup} activeBranchName={branchName(activeBranchId)}
        birthdayTargets={birthdayTargets} winbackTargets={winbackTargets}
        birthdayText={cfg.birthday_text} winbackText={cfg.winback_text} birthdayCustom={cfg.birthday_custom} winbackCustom={cfg.winback_custom} />

      {r.birthdays.length > 0 && (
        <div className="rounded-lg bg-pink-50 border border-pink-200 text-pink-900 px-3 py-2 text-sm">
          <b>วันเกิดเดือน{TH_MONTHS[r.month]}:</b>{" "}
          {r.birthdays.map((b) => `${b.day} ${TH_MONTHS[r.month]} · ${b.member_code}${b.consent ? "" : " (ไม่รับข่าวสาร)"}`).join(" / ")}
        </div>
      )}
      {r.summary.overdue > 0 && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 text-sm">
          <b>สมาชิกประจำที่เงียบไปนานกว่ารอบปกติ:</b> {withVisits.filter((m) => m.pattern!.overdue).map((m) => m.member_code).join(", ")}
        </div>
      )}

      {r.summary.members === 0 ? (
        <div className="card text-sm text-slate-400 text-center py-6">
          ยังไม่มีสมาชิก — พิมพ์ QR สมัครสมาชิกไปติดที่เคาน์เตอร์ ลูกค้าสแกนแล้วพิมพ์ “สมาชิก” ในแชท LINE ของสาขา
        </div>
      ) : (
        <div className="space-y-2">
          {withVisits.map((m) => {
            const p = m.pattern!;
            const n = p.visitsYear;
            const phaseClear = p.phase != null && n >= 2 && p.phase.count * 2 >= n;
            const dayClear = p.weekday != null && n >= 2 && p.weekday.count * 2 >= n;
            return (
              <div key={m.customer_hash} className={`rounded-xl border px-4 py-3 ${p.overdue ? "border-amber-200 bg-amber-50/40" : "border-slate-100 bg-white"}`}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <Link href={`/admin/insigna/customers/${m.customer_hash}`} className="font-bold text-slate-800 tabular-nums tracking-wider hover:text-brand">{m.member_code}</Link>
                    <div className="flex items-center gap-1.5 flex-wrap mt-1">
                      {genderTh(m.gender) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{genderTh(m.gender)}</span>}
                      {m.ageBand && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">อายุ {m.ageBand}</span>}
                      {m.home_area && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{m.home_area}</span>}
                      {m.source && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">รู้จักจาก {sourceLabel(m.source)}</span>}
                      {m.birthdayThisMonth && <span className="text-[10px] px-1.5 py-0.5 rounded bg-pink-100 text-pink-800">เกิดเดือนนี้</span>}
                      {!m.consent_marketing && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-400">ไม่รับข่าวสาร</span>}
                      {m.pendingBills > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">รอใบเสร็จ {m.pendingBills} ใบ</span>}
                      {p.overdue && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">เงียบนานกว่ารอบปกติ — ควรติดต่อ</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-lg font-bold text-slate-800 tabular-nums leading-tight">{baht(p.spendYear)}</div>
                    <div className="text-[11px] text-slate-500">
                      ปีนี้ {intTh(p.visitsYear)} ครั้ง{p.avgPerVisit != null ? ` · เฉลี่ยครั้งละ ${baht(p.avgPerVisit)}` : ""}
                      {p.visits !== p.visitsYear && <> · ทุกปี {intTh(p.visits)} ครั้ง {baht(p.spend)}</>}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 mt-3 text-sm">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-400">ความถี่</div>
                    <div className="text-slate-800">{p.cadence}</div>
                    {p.avgGapDays != null && <div className="text-[11px] text-slate-500">ห่างกันครั้งละ ~{intTh(p.avgGapDays)} วัน</div>}
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-400">มักมาเมื่อไหร่</div>
                    {n === 0 ? <div className="text-slate-300">—</div> : (
                      <>
                        <div className="text-slate-800">{phaseClear ? `${p.phase!.label} (${p.phase!.count} จาก ${n} ครั้ง)` : n === 1 ? `${p.phase?.label ?? "—"} (มาครั้งเดียว)` : "ช่วงเวลาไม่แน่นอน"}</div>
                        {n >= 2 && <div className="text-[11px] text-slate-500">ต้นเดือน {p.phaseCounts.early} · กลางเดือน {p.phaseCounts.mid} · ปลายเดือน {p.phaseCounts.late} ครั้ง</div>}
                        <div className={`text-[11px] mt-0.5 ${dayClear ? "text-slate-800" : "text-slate-500"}`}>
                          {p.weekday ? (dayClear ? `ส่วนใหญ่วัน${p.weekday.label} (${p.weekday.count} จาก ${n} ครั้ง)` : n === 1 ? `วัน${p.weekday.label}` : `ไม่มีวันประจำ บ่อยสุดวัน${p.weekday.label} (${p.weekday.count} จาก ${n} ครั้ง)`) : ""}
                        </div>
                      </>
                    )}
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-400">ใกล้วันหยุด</div>
                    {p.nearHoliday.count > 0 ? (
                      <>
                        <div className="text-amber-800">{intTh(p.nearHoliday.count)} ครั้ง</div>
                        <div className="text-[11px] text-slate-500">{p.nearHoliday.names.slice(0, 2).join(", ")}</div>
                      </>
                    ) : <div className="text-slate-400">ไม่มี</div>}
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-400">มาล่าสุด</div>
                    <div className="text-slate-800">{p.lastVisitLabel}</div>
                    <div className={`text-[11px] ${p.overdue ? "text-amber-700 font-medium" : "text-slate-500"}`}>{p.daysSinceLast > 0 ? `${intTh(p.daysSinceLast)} วันก่อน` : "วันนี้"}</div>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-slate-400 shrink-0">รายเดือน</span>
                  <div className="flex gap-1 flex-1 max-w-sm">
                    {p.months.map((v, i) => (
                      <div key={i} className="flex-1 min-w-0 text-center" title={`${TH_MONTHS[i + 1]}: ${v} ครั้ง`}>
                        <div className={`h-5 rounded flex items-center justify-center text-[10px] tabular-nums ${v > 0 ? (v / monthPeak >= 0.67 ? "bg-emerald-500 text-white" : "bg-emerald-200 text-emerald-900") : "bg-slate-100 text-slate-300"}`}>{v > 0 ? v : ""}</div>
                        <div className="text-[9px] text-slate-400 mt-0.5">{i + 1}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}

          {noVisits.length > 0 && (
            <div className="card">
              <div className="text-sm font-semibold text-slate-700 mb-2">สมาชิกที่ยังไม่มีบิลบันทึก ({intTh(noVisits.length)})</div>
              <div className="flex flex-wrap gap-1.5">
                {noVisits.map((m) => (
                  <Link key={m.customer_hash} href={`/admin/insigna/customers/${m.customer_hash}`}
                    className="text-xs px-2 py-1 rounded-lg bg-slate-50 border border-slate-100 text-slate-600 hover:border-brand tabular-nums">
                    {m.member_code}{m.member_since ? <span className="text-slate-400"> · สมัคร {formatLongDate(m.member_since, "th")}</span> : null}{m.birthdayThisMonth ? <span className="text-pink-700"> · เกิดเดือนนี้</span> : null}
                  </Link>
                ))}
              </div>
              <p className="text-[11px] text-slate-400 mt-2">บิลจะปรากฏเมื่อพนักงานสแกนบัตรตอนชำระเงิน และไฟล์ใบเสร็จของวันนั้นถูกนำเข้าใน ANALYTICA</p>
            </div>
          )}
          <p className="text-[11px] text-slate-400">
            เรียงตามยอดปีที่เลือก · บิลวันเดียวกันนับเป็น 1 ครั้ง · ความถี่คิดจากช่วงที่มีข้อมูลในปีนี้ · มักมาเมื่อไหร่ = ต้นเดือน (วันที่ 1–10) / กลางเดือน (11–20) / ปลายเดือน (21–31) และวันในสัปดาห์ นับเป็น “ประจำ” เมื่ออย่างน้อยครึ่งหนึ่งของครั้งที่มาปีนี้ตกในช่วงหรือวันนั้น · ใกล้วันหยุด = ภายใน ±3 วันของวันหยุดนักขัตฤกษ์ · “เงียบนานกว่าปกติ” = ไม่มาเกิน 1.5 เท่าของระยะห่างปกติ
            {branchId ? ` · นับเฉพาะบิลที่ ${branchName(branchId)}` : ""}
          </p>
        </div>
      )}
    </div>
  );
}
