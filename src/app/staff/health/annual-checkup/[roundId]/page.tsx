import type { Metadata } from "next";
import { glueCompany } from "@/lib/text";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { normExamCode } from "@/lib/health-report/lab-import";
import { getRoundLineGaps, getRoundOverview, isAnnualCheckupInvalid, isApproverUser, isLdlAutoOn, listMyReturns } from "@/lib/annual-checkup-db";
import { isUnlocked, requireClinicalUser } from "@/lib/annual-checkup-api";
import ReleaseCompany from "./ReleaseCompany";
import AddExternal from "./AddExternal";
import LdlFill from "./LdlFill";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ผลตรวจสุขภาพประจำปี · NOKHOOK OS PORTAL" };

const FILTERS: Array<{ v: string; th: string }> = [
  { v: "", th: "ทั้งหมด" }, { v: "todo", th: "ยังลงผลไม่ครบ" }, { v: "verify", th: "ส่งแพทย์แล้ว รอตรวจสอบ" }, { v: "release", th: "รอเปิดผล" }, { v: "done", th: "เปิดผลแล้ว" }
];

export default function RoundOverviewPage({ params, searchParams }: { params: { roundId: string }; searchParams: { f?: string; q?: string; t?: string } }) {
  const user = requireClinicalUser();
  const roundId = Number(params.roundId);
  if (!Number.isInteger(roundId) || roundId <= 0) notFound();
  let data: ReturnType<typeof getRoundOverview>;
  try { data = getRoundOverview(user, roundId); } catch (e) { if (isAnnualCheckupInvalid(e)) notFound(); throw e; }
  const lineGaps = getRoundLineGaps(user, roundId);
  const myReturns = listMyReturns(user, roundId);
  const approver = isApproverUser(user.id);
  const externalPayers = getDb().prepare("SELECT id, name_th AS name FROM annual_checkup_payers WHERE round_id = ? AND is_external = 1 ORDER BY id").all(roundId) as Array<{ id: number; name: string }>;
  const payers = approver ? (getDb().prepare("SELECT id, name_th AS name FROM annual_checkup_payers WHERE round_id = ? ORDER BY id").all(roundId) as Array<{ id: number; name: string }>) : [];
  const f = searchParams.f ?? "";
  const q = (searchParams.q ?? "").trim().toLowerCase();
  // the laboratory's examination code per person (AHC69-0001); a scanned tube label (AHC69-0001-R) is cut back to the code
  const examCode = new Map<string, string>();
  for (const r of getDb().prepare("SELECT user_id, external_id, exam_code FROM annual_checkup_exam_codes WHERE round_id = ?").all(roundId) as Array<{ user_id: number | null; external_id: number | null; exam_code: string }>) examCode.set(r.user_id != null ? `u${r.user_id}` : `e${r.external_id}`, r.exam_code);
  const scanned = q ? normExamCode(q) : "";
  const byScan = scanned ? data.subjects.filter((s) => examCode.get(s.key) === scanned) : [];
  if (byScan.length === 1) redirect(`/staff/health/annual-checkup/${roundId}/person/${byScan[0].key}`);   // scan a tube → open that person
  const t = searchParams.t === "staff" || searchParams.t === "ext" ? searchParams.t : "";
  const nExt = data.subjects.filter((s) => s.kind === "external").length;
  const subjects = data.subjects.filter((s) => {
    if (t === "staff" && s.kind !== "employee") return false;
    if (t === "ext" && s.kind !== "external") return false;
    if (q && !`${s.label} ${s.code ?? ""} ${examCode.get(s.key) ?? ""}`.toLowerCase().includes(q)) return false;
    if (f === "todo") return s.recorded < s.required;
    if (f === "verify") return s.recorded === s.required && s.submitted && s.verified < s.required;
    if (f === "release") return s.verified === s.required && s.released < s.required;
    if (f === "done") return s.required > 0 && s.released === s.required;
    return true;
  });
  const state = (s: (typeof data.subjects)[number]) => s.returned ? { th: "ส่งกลับให้แก้ไข", cls: "bg-amber-100 text-amber-800" }
    : s.conclusionReleased && s.required > 0 && s.released < s.required ? { th: "แก้ไขหลังเปิดผล รออนุมัติใหม่", cls: "bg-rose-100 text-rose-700" }
    : s.required > 0 && s.released === s.required ? { th: "เปิดผลแล้ว", cls: "bg-emerald-100 text-emerald-700" }
    : s.verified === s.required && s.required > 0 ? { th: "รอเปิดผล", cls: "bg-sky-100 text-sky-700" }
    : s.recorded === s.required && s.required > 0 ? (s.submitted ? { th: "รอแพทย์ตรวจสอบ", cls: "bg-violet-100 text-violet-700" } : { th: "ลงผลครบ ยังไม่ส่งแพทย์", cls: "bg-indigo-100 text-indigo-700" })
    : s.recorded === 0 ? { th: "ยังไม่ลงผล", cls: "bg-slate-100 text-slate-600" } : { th: "ลงผลบางส่วน", cls: "bg-amber-100 text-amber-800" };
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
  const totReq = data.tests.reduce((n, x) => n + x.required, 0), totRec = data.tests.reduce((n, x) => n + x.recorded, 0), totVer = data.tests.reduce((n, x) => n + x.verified, 0), totRel = data.tests.reduce((n, x) => n + x.released, 0);
  const href = (o: { f?: string; t?: string }) => `?${new URLSearchParams({ ...((o.t ?? t) ? { t: o.t ?? t } : {}), ...((o.f ?? f) ? { f: o.f ?? f } : {}), ...(q ? { q } : {}) }).toString()}`;
  const Bar = ({ v, tone }: { v: number; tone: string }) => <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden" role="presentation"><div className={`h-full rounded-full ${tone}`} style={{ width: `${v}%` }} /></div>;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3"><Link href="/staff/health/annual-checkup" className="text-sm text-slate-500 hover:text-brand min-h-[44px] inline-flex items-center">← รอบทั้งหมด</Link></div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-xl font-bold text-slate-800">{data.round.name}</h1>
        <div className="text-sm text-slate-600">{data.subjects.length} คน{nExt > 0 ? ` (ภายนอก ${nExt})` : ""}</div>
      </div>

      {/* where the round stands */}
      <section className="card space-y-3" aria-label="ความคืบหน้าของรอบ">
        {[["ลงผลแล้ว", totRec, "nk-gradient opacity-50"], ["แพทย์ตรวจสอบแล้ว", totVer, "nk-gradient opacity-75"], ["เปิดผลแล้ว", totRel, "nk-gradient"]].map(([label, n, tone]) => (
          <div key={label as string}>
            <div className="flex justify-between text-sm"><span className="text-slate-700">{label}</span><span className="tabular-nums font-semibold text-slate-900">{n as number}/{totReq} <span className="text-xs text-slate-500">({pct(n as number, totReq)}%)</span></span></div>
            <Bar v={pct(n as number, totReq)} tone={tone as string} />
          </div>
        ))}
        <div className="flex flex-wrap gap-2 pt-1">
          <Link href={`/staff/health/annual-checkup/${roundId}/overview`} className="btn-secondary text-sm min-h-[44px] inline-flex items-center px-4">ภาพรวมและงานค้าง</Link>
          <Link href={`/staff/health/annual-checkup/${roundId}/import`} className="btn-secondary text-sm min-h-[44px] inline-flex items-center px-4">นำเข้าผลจากไฟล์แล็บ</Link>
          <Link href={`/staff/health/annual-checkup/${roundId}/item/FBS`} className="btn-secondary text-sm min-h-[44px] inline-flex items-center px-4">ลงผลรายรายการ</Link>
        </div>
      </section>

      {lineGaps.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          ผลออกแล้วแต่ยังไม่ได้ผูก LINE จึงไม่ได้รับแจ้ง ({lineGaps.length} คน): {lineGaps.join(", ")} — แจ้งให้เปิดดูผลในพอร์ทัลได้เอง
        </div>
      )}
      {myReturns.length > 0 && (
        <div className="card border-amber-300 bg-amber-50 space-y-1">
          <div className="text-sm font-semibold text-amber-900">งานค้างของท่าน: แพทย์ส่งกลับให้แก้ไข ({myReturns.length})</div>
          {myReturns.map((j) => <div key={j.key} className="text-sm"><Link href={`/staff/health/annual-checkup/${roundId}/person/${j.key}/entry`} className="text-brand hover:underline font-medium">{j.label}</Link> — {j.note} <span className="text-xs text-slate-500">({j.by_name})</span></div>)}
        </div>
      )}

      {/* the people: the thing most people come here for */}
      <section className="card space-y-3" aria-label="รายคน">
        <form method="get" className="flex gap-2">
          {f && <input type="hidden" name="f" value={f} />}{t && <input type="hidden" name="t" value={t} />}
          <input name="q" defaultValue={searchParams.q ?? ""} placeholder="ค้นหาชื่อ รหัส หรือสแกนบาร์โค้ดหลอด" autoFocus className="input min-h-[44px] flex-1 min-w-0" />
          <button type="submit" className="btn-primary min-h-[44px] px-5">ค้นหา</button>
        </form>
        {nExt > 0 && (
          <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-slate-500 w-12">กลุ่ม</span>
            {[{ v: "", th: "ทั้งหมด" }, { v: "staff", th: "พนักงาน" }, { v: "ext", th: `ภายนอก (${nExt})` }].map((x) => <Link key={`t${x.v}`} href={href({ t: x.v })} className={`chip ${t === x.v ? "chip-active" : ""}`}>{x.th}</Link>)}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-slate-500 w-12">สถานะ</span>
          {FILTERS.map((x) => <Link key={x.v} href={href({ f: x.v })} className={`chip ${f === x.v ? "chip-active" : ""}`}>{x.th}</Link>)}
        </div>
        <div className="text-sm font-semibold text-slate-800">รายคน ({subjects.length})</div>
        {subjects.length === 0 && <p className="text-sm text-slate-500 py-4 text-center">ไม่พบรายชื่อที่ตรงกับตัวกรอง</p>}
        <ul className="divide-y divide-slate-100">
          {subjects.map((s) => {
            const st = state(s);
            return (
              <li key={s.key}>
                <Link href={`/staff/health/annual-checkup/${roundId}/person/${s.key}`} className="flex items-center gap-3 py-2.5 min-h-[56px] hover:bg-slate-50 -mx-2 px-2 rounded-lg">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5"><span className="font-semibold text-slate-900 break-words">{s.label}</span>{s.kind === "external" && <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-800">ภายนอก · {glueCompany(s.payer)}</span>}</div>
                    <div className="text-[11px] text-slate-500">{s.kind === "external" ? "ผู้รับการตรวจภายนอก" : `${s.code ?? ""} · ${glueCompany(s.payer)}`}{examCode.get(s.key) ? ` · ${examCode.get(s.key)}` : ""}</div>
                    <div className="mt-1.5 flex items-center gap-2"><div className="flex-1"><Bar v={pct(s.recorded, s.required)} tone="nk-gradient" /></div><span className="text-[11px] tabular-nums text-slate-600 w-20 text-right">ลง {s.recorded}/{s.required} · ตรวจ {s.verified}</span></div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium text-center max-w-[7.5rem] ${st.cls}`}>{st.th}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {isLdlAutoOn() && <LdlFill roundId={roundId} />}
      <AddExternal roundId={roundId} payers={externalPayers} />
      {approver && payers.length > 0 && <ReleaseCompany roundId={roundId} payers={payers} unlocked={isUnlocked(user)} />}
      {externalPayers.length > 0 && (
        <div className="card flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-slate-800 w-full">สรุปสถานะสำหรับบริษัทผู้จ่าย (ไม่มีค่าผลตรวจรายคน)</span>
          {externalPayers.map((p) => <Link key={p.id} href={`/staff/health/annual-checkup/${roundId}/sponsor/${p.id}`} className="btn-secondary min-h-[44px] inline-flex items-center px-4">{glueCompany(p.name)}</Link>)}
        </div>
      )}

      <details className="card">
        <summary className="cursor-pointer select-none min-h-[44px] flex items-center text-sm font-semibold text-slate-800">ความคืบหน้ารายรายการตรวจ ({data.tests.length})</summary>
        <ul className="mt-2 divide-y divide-slate-100">
          {data.tests.map((x) => (
            <li key={x.code} className="py-2">
              <div className="flex items-center justify-between gap-3"><Link href={`/staff/health/annual-checkup/${roundId}/test/${x.code}`} className="text-brand hover:underline text-sm">{x.nameTh}</Link><span className="text-xs tabular-nums text-slate-600">ลง {x.recorded}/{x.required} · ตรวจ {x.verified} · เปิด {x.released}</span></div>
              <div className="mt-1"><Bar v={pct(x.recorded, x.required)} tone="nk-gradient" /></div>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
