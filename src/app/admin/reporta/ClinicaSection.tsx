"use client";

import OwlMascot from "@/app/components/OwlMascot";
// Type-only import (erased from the client bundle, so the server-only db code in
// clinica-analytics is never pulled in) — the single source of truth for the
// shape, re-exported for the rest of the client tree.
import type { ClinicaMonth } from "@/lib/clinica-analytics";
export type { ClinicaMonth };

// The คลินิก section of ANALYTICA (owner 2026-09-26). Headline is ยอดบิลรวม,
// split into เงินเข้าจริง (เงินสด/พร้อมเพย์) vs รอเบิกประกัน (AR + aging), plus payer
// mix, revenue categories, top ยา/แล็บ, diagnoses, doctors and peak hours. Every
// money figure carries its count (ครั้ง) in parentheses.

const baht = (n: number) => `฿${Math.round(n).toLocaleString("th-TH")}`;
/** Money with its count in parentheses — the house style (owner 2026-09-26). */
const bahtC = (n: number, c: number) => `${baht(n)} (${c.toLocaleString("th-TH")} ครั้ง)`;

function Pct({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  const up = pct >= 0;
  return <span className={up ? "text-emerald-600" : "text-rose-600"}>{up ? "↑" : "↓"} {Math.abs(pct)}%</span>;
}
function Bar({ value, max, tone = "bg-brand" }: { value: number; max: number; tone?: string }) {
  return (
    <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
      <div className={`h-full ${tone}`} style={{ width: `${max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0}%` }} />
    </div>
  );
}

export default function ClinicaSection({ c, onSendReport, sentAt, canSend, disabledReason }: {
  c: ClinicaMonth;
  onSendReport?: () => void;
  sentAt?: string | null;
  canSend?: boolean;
  disabledReason?: string;
}) {
  const maxCat = Math.max(1, ...c.categories.map((x) => x.net));
  const maxItem = Math.max(1, ...c.topItems.map((x) => x.net));
  const maxDx = Math.max(1, ...c.topDiagnoses.map((x) => x.count));
  const maxHour = Math.max(1, ...c.hours.map((x) => x.count));
  const maxPayer = Math.max(1, ...c.payers.map((x) => x.net));
  const maxDaily = Math.max(1, ...c.daily.map((x) => x.net));
  const totalPatientsMix = c.newPatients + c.returningPatients;
  const maxDemoAge = Math.max(1, ...c.demographics.ageBands.map((x) => x.count));
  const arPct = c.billNet > 0 ? Math.round((c.due / c.billNet) * 100) : 0;
  // Contiguous hour axis (zero-fill gaps between the earliest and latest hour so
  // the time axis reads honestly).
  const hourBars: Array<{ hour: number; count: number }> = (() => {
    if (!c.hours.length) return [];
    const lo = c.hours[0].hour, hi = c.hours[c.hours.length - 1].hour;
    const byHour = new Map(c.hours.map((h) => [h.hour, h.count]));
    const out: Array<{ hour: number; count: number }> = [];
    for (let h = lo; h <= hi; h++) out.push({ hour: h, count: byHour.get(h) ?? 0 });
    return out;
  })();
  // Zero-fill missing days between the first and last billed day so a sparse
  // month reads honestly (same rule as the hour axis).
  const dailyBars = (() => {
    if (!c.daily.length) return c.daily;
    const nextDay = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
    const byDate = new Map(c.daily.map((d) => [d.date, d]));
    const out: typeof c.daily = [];
    for (let cur = c.daily[0].date, last = c.daily[c.daily.length - 1].date; cur <= last; cur = nextDay(cur)) {
      out.push(byDate.get(cur) ?? { date: cur, net: 0, count: 0 });
    }
    return out;
  })();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold text-slate-800">คลินิก · วิเคราะห์เชิงลึก</h2>
        {onSendReport && (
          <div className="flex items-center gap-2 flex-wrap">
            {sentAt && <span className="text-xs text-emerald-600">✓ ส่งสรุปเดือนแล้ว</span>}
            {!canSend && disabledReason && <span className="text-xs text-amber-600">{disabledReason}</span>}
            <button onClick={onSendReport} disabled={!canSend} title={!canSend ? disabledReason : undefined}
              className="btn-success text-sm px-4 py-2 disabled:opacity-50">
              {sentAt ? "ส่งรายงานผู้บริหารอีกครั้ง" : "ส่งรายงานผู้บริหาร"}
            </button>
          </div>
        )}
      </div>

      {/* บทสรุป & คำแนะนำจากน้องฮูก — mirrors the restaurant report's summary card
          (owner 2026-09-26). Sits on top so the read starts with the takeaway. */}
      {c.advice.length > 0 && (
        <div className="card">
          <div className="flex items-start gap-3">
            <OwlMascot size={40} mood="thinking" className="shrink-0" ariaLabel="น้องฮูก" />
            <div className="min-w-0">
              <h3 className="font-bold text-slate-800 text-sm">สรุป &amp; คำแนะนำจากน้องฮูก</h3>
              <ul className="space-y-1 mt-1">
                {c.advice.map((line, i) => (
                  <li key={i} className="flex gap-2 text-sm text-slate-700">
                    <span className="text-brand">•</span><span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Headline */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card col-span-2 md:col-span-1">
          <div className="text-xs text-slate-500">ยอดบิลรวมเดือนนี้</div>
          <div className="text-xl font-bold text-slate-800 tabular-nums">{baht(c.billNet)}</div>
          <div className="text-[11px] text-slate-400">{c.billCount.toLocaleString("th-TH")} ครั้ง</div>
          <div className="text-[11px] mt-0.5">เทียบเดือนก่อน <Pct pct={c.billNetMomPct} />{c.prevBillNet != null && <span className="text-slate-400"> ({baht(c.prevBillNet)})</span>}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">เงินเข้าจริง (เงินสด/พร้อมเพย์)</div>
          <div className="text-lg font-bold text-emerald-700 tabular-nums">{baht(c.paid)}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">รอเบิก (บิลเดือนนี้)</div>
          <div className="text-lg font-bold text-rose-600 tabular-nums">{baht(c.due)}</div>
          <div className="text-[10px] text-slate-400">{arPct}% ของยอดบิลเดือนนี้</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">คนไข้ (บิล)</div>
          <div className="text-lg font-bold text-slate-800 tabular-nums">{c.patientCount.toLocaleString("th-TH")} คน</div>
          <div className="text-[10px] text-slate-400">เฉลี่ย/บิล {c.avgPerBill != null ? baht(c.avgPerBill) : "—"}</div>
        </div>
      </div>

      {/* Monthly target + month-end projection (owner 2026-09-26) — set the target
          on the ตั้งค่ากลุ่ม LINE page. */}
      {c.target && (
        <div className="card space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="text-slate-500">เป้ายอดบิลเดือนนี้ · {baht(c.target.target)}</span>
            <span className={`font-bold ${c.target.pct >= 100 ? "text-emerald-600" : "text-slate-700"}`}>{c.target.pct.toFixed(0)}% ของเป้า</span>
          </div>
          <div className="h-2.5 rounded-full bg-slate-200 overflow-hidden">
            <div className={`h-full ${c.target.pct >= 100 ? "bg-emerald-500" : "bg-emerald-400"}`} style={{ width: `${Math.min(100, c.target.pct)}%` }} />
          </div>
          <div className="text-[11px] text-slate-500">
            {c.target.isCurrent
              ? <>คาดสิ้นเดือน <b className={c.target.onTrack ? "text-emerald-600" : "text-amber-600"}>{baht(c.target.projected)}</b> ({c.target.projectedPct.toFixed(0)}% ของเป้า) · {c.target.onTrack ? "มีแนวโน้มถึงเป้า ✓" : "ต่ำกว่าเป้า ต้องเร่ง"}</>
              : <>ทำได้จริง <b className={c.target.pct >= 100 ? "text-emerald-600" : "text-amber-600"}>{baht(c.billNet)}</b> ({c.target.pct.toFixed(0)}% ของเป้า) · {c.target.pct >= 100 ? "ถึงเป้า ✓" : "ไม่ถึงเป้า"}</>}
          </div>
        </div>
      )}

      {/* Patient growth (new vs returning) + demographics (owner 2026-09-26) */}
      {(totalPatientsMix > 0 || c.demographics.male + c.demographics.female + c.demographics.other > 0) && (
        <div className="card grid md:grid-cols-2 gap-4">
          {totalPatientsMix > 0 && (
            <div className="space-y-1.5">
              <h3 className="font-bold text-slate-800 text-sm">คนไข้ใหม่ vs กลับมาซ้ำ</h3>
              {([["คนไข้ใหม่", c.newPatients, "bg-emerald-400"], ["กลับมาซ้ำ", c.returningPatients, "bg-sky-400"]] as Array<[string, number, string]>).map(([lb, v, tone]) => (
                <div key={lb} className="text-[11px]">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-slate-600">{lb}</span>
                    <span className="text-slate-700 tabular-nums">{v.toLocaleString("th-TH")} คน ({Math.round((v / totalPatientsMix) * 100)}%)</span>
                  </div>
                  <Bar value={v} max={totalPatientsMix} tone={tone} />
                </div>
              ))}
              <p className="text-[10px] text-slate-400">คนไข้ใหม่ = บิลแรกสุด (ทุกงวด) อยู่ในเดือนนี้</p>
            </div>
          )}
          <div className="space-y-1.5">
            <h3 className="font-bold text-slate-800 text-sm">ประชากรคนไข้ (จาก OPD)</h3>
            <div className="flex gap-3 text-[11px] text-slate-700">
              <span>ชาย <b className="tabular-nums">{c.demographics.male.toLocaleString("th-TH")}</b></span>
              <span>หญิง <b className="tabular-nums">{c.demographics.female.toLocaleString("th-TH")}</b></span>
              {c.demographics.other > 0 && <span>อื่นๆ <b className="tabular-nums">{c.demographics.other.toLocaleString("th-TH")}</b></span>}
            </div>
            {c.demographics.withAge > 0 ? (
              <div className="space-y-1 pt-0.5">
                {c.demographics.ageBands.map((a) => (
                  <div key={a.label} className="text-[11px]">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-slate-600">{a.label} ปี</span>
                      <span className="text-slate-700 tabular-nums">{a.count.toLocaleString("th-TH")} คน</span>
                    </div>
                    <Bar value={a.count} max={maxDemoAge} tone="bg-indigo-300" />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-slate-400">ยังไม่มีวันเกิดในไฟล์ OPD สำหรับคิดช่วงอายุ</p>
            )}
          </div>
        </div>
      )}

      {/* Daily billing trend (owner 2026-09-26) */}
      {c.daily.length > 0 && (
        <div className="card space-y-1.5">
          <h3 className="font-bold text-slate-800 text-sm">ยอดบิลรายวัน</h3>
          <div className="flex items-end gap-0.5 h-24">
            {dailyBars.map((d) => (
              <div key={d.date} className="flex-1 flex flex-col items-center justify-end" title={`${d.date} · ${baht(d.net)} · ${d.count} บิล`}>
                <div className="w-full bg-teal-400 rounded-t" style={{ height: `${Math.max(3, Math.round((d.net / maxDaily) * 80))}px` }} />
                <span className="text-[8px] text-slate-400">{d.date.slice(8, 10)}</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-slate-400">แต่ละแท่ง = ยอดบิลรวมของวันนั้น (แตะเพื่อดูยอด/จำนวนบิล)</p>
        </div>
      )}

      {/* AR aging + payer owing */}
      {c.arTotal > 0 && (
        <div className="card space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-slate-800 text-sm">ค้างชำระคงค้าง · รอเบิกประกัน (ทุกงวด · ณ วันนี้)</h3>
            <span className="text-sm font-bold text-rose-600">{baht(c.arTotal)}</span>
          </div>
          <div className="grid grid-cols-4 gap-2 text-center">
            {[["0–30 วัน", c.arAging.d0_30], ["31–60", c.arAging.d31_60], ["61–90", c.arAging.d61_90], ["90+ วัน", c.arAging.d90p]].map(([lb, v], i) => (
              <div key={i} className="rounded-lg border border-slate-200 p-2">
                <div className="text-[10px] text-slate-400">{lb as string}</div>
                <div className={`text-sm font-bold tabular-nums ${i >= 2 && (v as number) > 0 ? "text-rose-600" : "text-slate-700"}`}>{baht(v as number)}</div>
              </div>
            ))}
          </div>
          <div className="space-y-1.5 pt-1">
            {c.arByPayer.slice(0, 6).map((p) => {
              // Per-payer aging: which buckets this payer's outstanding sits in, so
              // the owner can tell who is overdue how long (owner 2026-09-26).
              // Bills with no/invalid bill_date can't be aged, so they sit in
              // p.due but in no bucket. Surface the remainder as "ไม่ระบุวันที่" so
              // the breakdown reconciles with the owed figure (owner 2026-09-26).
              const bucketSum = p.aging.d0_30 + p.aging.d31_60 + p.aging.d61_90 + p.aging.d90p;
              const undated = Math.round((p.due - bucketSum) * 100) / 100;
              const buckets: Array<[string, number, boolean]> = [
                ["0–30 วัน", p.aging.d0_30, false], ["31–60 วัน", p.aging.d31_60, false],
                ["61–90 วัน", p.aging.d61_90, true], ["90+ วัน", p.aging.d90p, true],
                ...(undated > 0.5 ? [["ไม่ระบุวันที่", undated, false] as [string, number, boolean]] : []),
              ];
              const shown = buckets.filter(([, v]) => v > 0.5);
              return (
                <div key={p.group}>
                  <div className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="text-slate-600 truncate">{p.group}</span>
                    <span className="text-rose-600 tabular-nums whitespace-nowrap">{bahtC(p.due, p.count)}</span>
                  </div>
                  {shown.length > 0 && (
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] mt-0.5">
                      {shown.map(([lb, v, old]) => (
                        <span key={lb} className={old ? "text-rose-500" : "text-slate-400"}>{lb}: {baht(v)}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-slate-400">อายุหนี้นับจากวันที่ในบิลถึงวันนี้ · เกิน 60 วันแสดงเป็นสีแดง</p>
        </div>
      )}

      {/* Payer mix */}
      {c.payers.length > 0 && (
        <div className="card space-y-1.5">
          <h3 className="font-bold text-slate-800 text-sm">สัดส่วนตามกลุ่มผู้จ่าย</h3>
          {c.payers.slice(0, 8).map((p) => (
            <div key={p.group} className="text-[11px]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-600 truncate">{p.group}</span>
                <span className="text-slate-700 tabular-nums whitespace-nowrap">{bahtC(p.net, p.count)}{p.due > 0.5 && <span className="text-rose-500"> · ค้าง {baht(p.due)}</span>}</span>
              </div>
              <Bar value={p.net} max={maxPayer} tone={p.due > 0.5 ? "bg-rose-300" : "bg-emerald-400"} />
            </div>
          ))}
        </div>
      )}

      {/* Revenue by category */}
      {c.categories.length > 0 && (
        <div className="card space-y-1.5">
          <h3 className="font-bold text-slate-800 text-sm">โครงสร้างรายได้</h3>
          {c.categories.map((cat) => (
            <div key={cat.key} className="text-[11px]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-600">{cat.label}</span>
                <span className="text-slate-700 tabular-nums whitespace-nowrap">{bahtC(cat.net, cat.count)}</span>
              </div>
              <Bar value={cat.net} max={maxCat} />
            </div>
          ))}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {/* Top items (drugs/labs/services) */}
        {c.topItems.length > 0 && (
          <div className="card space-y-1.5">
            <h3 className="font-bold text-slate-800 text-sm">รายการทำเงินสูงสุด</h3>
            {c.topItems.slice(0, 8).map((it) => (
              <div key={it.name} className="text-[11px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-slate-600 truncate">{it.name}</span>
                  <span className="text-slate-700 tabular-nums whitespace-nowrap">{baht(it.net)} ({it.qty.toLocaleString("th-TH")} ครั้ง)</span>
                </div>
                <Bar value={it.net} max={maxItem} tone="bg-violet-400" />
              </div>
            ))}
          </div>
        )}

        {/* Diagnoses */}
        {c.topDiagnoses.length > 0 && (
          <div className="card space-y-1.5">
            <h3 className="font-bold text-slate-800 text-sm">วินิจฉัยที่พบบ่อย</h3>
            {c.topDiagnoses.slice(0, 8).map((d) => (
              <div key={d.name} className="text-[11px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-slate-600 truncate">{d.name}</span>
                  <span className="text-slate-700 tabular-nums whitespace-nowrap">{d.count.toLocaleString("th-TH")} ครั้ง</span>
                </div>
                <Bar value={d.count} max={maxDx} tone="bg-sky-400" />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Doctors + hours */}
      <div className="grid md:grid-cols-2 gap-4">
        {c.doctors.length > 0 && (
          <div className="card space-y-1">
            <h3 className="font-bold text-slate-800 text-sm">ผู้ป่วยต่อแพทย์ (visit)</h3>
            {c.doctors.map((d) => (
              <div key={d.name} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="text-slate-600 truncate">{d.name}</span>
                <span className="text-slate-700 tabular-nums">{d.count.toLocaleString("th-TH")} ครั้ง</span>
              </div>
            ))}
            <div className="text-[10px] text-slate-400 pt-0.5">รวม {c.visitCount.toLocaleString("th-TH")} visit · {c.visitPatientCount.toLocaleString("th-TH")} คนไข้</div>
          </div>
        )}
        {c.hours.length > 0 && (
          <div className="card space-y-1.5">
            <h3 className="font-bold text-slate-800 text-sm">ช่วงเวลาที่คนไข้เข้ามาก (ตามบิล)</h3>
            <div className="flex items-end gap-1 h-20">
              {hourBars.map((h) => (
                <div key={h.hour} className="flex-1 flex flex-col items-center justify-end gap-0.5">
                  <div className="w-full bg-amber-400 rounded-t" style={{ height: `${Math.max(4, Math.round((h.count / maxHour) * 64))}px` }} title={`${h.count} ครั้ง`} />
                  <span className="text-[9px] text-slate-400">{String(h.hour).padStart(2, "0")}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
