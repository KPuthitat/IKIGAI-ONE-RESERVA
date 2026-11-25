import type { Report, RSection } from "@/lib/health-report/report";
import { glueCompany } from "@/lib/text";
import { withArrow } from "@/lib/health-report/interpret";

// The health check-up report on screen (mobile first): navy section bars, grey striped rows, cream boxes, the three years side by side.
// A flag is always a WORD (สูง / ต่ำ / ผิดปกติ) next to the colour, never colour alone. Server component: nothing here fetches.

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
export const thaiLongDate = (iso: string | null | undefined) => { if (!iso) return "—"; const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return `${d}\u00A0${TH_MONTHS[m - 1]}\u00A0${y + 543}`; };
const NAVY = "nk-gradient";

function Bar({ children }: { children: React.ReactNode }) {
  return <h2 className={`${NAVY} text-white font-bold text-base sm:text-lg rounded-xl px-4 py-2.5 text-center`}>{children}</h2>;
}
const flagCls = (w: string) => (w ? "text-rose-700 font-semibold" : "text-slate-800");

function Explain({ text }: { text: string }) {
  return (
    <details className="mt-1 group">
      <summary className="inline-flex items-center min-h-[44px] px-3 rounded-lg border border-slate-300 text-xs text-slate-700 cursor-pointer select-none list-none">รายการนี้คืออะไร</summary>
      <p className="mt-1 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-700 whitespace-pre-line">{text}</p>
    </details>
  );
}

function Section({ s, years, fileHref }: { s: RSection; years: number[]; fileHref: (id: number) => string }) {
  const yearsShown = years.length ? years : [0];
  return (
    <section className="space-y-3 scroll-mt-16" id={`sec-${s.key}`}>
      <Bar>{s.th} <span className="font-normal opacity-90">· {s.en}</span></Bar>
      {s.intro && <p className="text-sm text-slate-700 px-1 whitespace-pre-line">{s.intro.body}</p>}
      {s.rows.length > 0 && (
        <>
          {/* wide screens: the table of the booklet */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-slate-600">
                <th className="text-left py-1.5 px-3 font-semibold">ค่าที่ตรวจได้</th>
                {yearsShown.map((y, i) => <th key={y} className={`py-1.5 px-2 text-center underline ${i === yearsShown.length - 1 ? "font-bold text-slate-900" : "font-normal"}`}>{y || "ผล"}</th>)}
                <th className="py-1.5 px-2 text-center font-semibold">ค่าอ้างอิง</th><th className="py-1.5 px-2 text-center font-semibold">หน่วย</th>
              </tr></thead>
              <tbody>
                {s.rows.map((r, i) => (
                  <tr key={r.code} className={`align-top ${i % 2 === 0 ? "bg-slate-100" : "bg-slate-50"}`}>
                    <td className="py-2 px-3 rounded-l-lg"><div className="font-bold text-slate-900">{r.en}</div><div className="text-[11px] text-slate-500">{r.th}</div>{r.explain && <Explain text={r.explain} />}</td>
                    {r.cells.map((c, k) => <td key={k} className={`py-2 px-2 text-center ${k === r.cells.length - 1 ? `font-bold ${flagCls(r.flagWord)}` : "text-slate-500"}`}>{c.text}{k === r.cells.length - 1 && r.flagWord ? <div className="text-xs">{withArrow(r.flagWord)}</div> : null}</td>)}
                    <td className="py-2 px-2 text-center text-xs text-slate-600 whitespace-pre-line">{r.ref || "—"}</td>
                    <td className="py-2 px-2 text-center text-xs text-slate-600 rounded-r-lg">{r.unit || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* phones: one card per item */}
          <div className="sm:hidden space-y-2">
            {s.rows.map((r, i) => (
              <div key={r.code} className={`rounded-xl px-3 py-2.5 ${i % 2 === 0 ? "bg-slate-100" : "bg-slate-50"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><div className="font-bold text-slate-900 break-words">{r.en}</div><div className="text-[11px] text-slate-500">{r.th}</div></div>
                  <div className={`text-right shrink-0 ${flagCls(r.flagWord)}`}><div className="text-lg font-bold leading-tight">{r.cells[r.cells.length - 1]?.text}</div><div className="text-xs">{r.unit}{r.flagWord ? ` · ${withArrow(r.flagWord)}` : ""}</div></div>
                </div>
                {r.ref && <div className="mt-1 text-[11px] text-slate-500 whitespace-pre-line">อ้างอิง {r.ref}</div>}
                {r.cells.length > 1 && r.cells.slice(0, -1).some((c) => c.text !== "-") && <div className="mt-1 text-[11px] text-slate-500">ปีก่อน: {r.cells.slice(0, -1).map((c) => `${c.year} = ${c.text}`).join(" · ")}</div>}
                {r.explain && <Explain text={r.explain} />}
              </div>
            ))}
          </div>
        </>
      )}
      {s.lines.length > 0 && <div className="rounded-xl bg-white border border-slate-200 shadow-card px-4 py-3 text-sm text-slate-800 space-y-1"><div className="font-bold">สรุปผลจากระบบ</div>{s.lines.map((l, i) => <div key={i} className="pl-3 -indent-3">- {l}</div>)}</div>}
      {s.file && <a href={fileHref(s.file.resultId)} target="_blank" rel="noopener" className="inline-flex items-center min-h-[44px] px-4 rounded-lg border border-slate-300 text-sm text-brand underline">เปิดภาพ/ไฟล์ผลตรวจ</a>}
      {s.note && (
        <div className="rounded-xl bg-white border border-slate-200 shadow-card px-4 py-3 text-sm text-slate-800 space-y-2">
          {s.note.summary && <div><div className="font-bold">สรุปผล · Summary</div><div className="whitespace-pre-line">{s.note.summary}</div></div>}
          {s.note.recommendation && <div><div className="font-bold">คำแนะนำโดยแพทย์ · Doctor&apos;s recommendation</div><div className="whitespace-pre-line">{s.note.recommendation}</div></div>}
        </div>
      )}
      {s.edu && <details><summary className="inline-flex items-center min-h-[44px] px-3 rounded-lg border border-slate-300 text-sm text-slate-700 cursor-pointer select-none list-none">ความรู้เพิ่มเติม: {s.edu.title.split("·")[0].trim()}</summary><p className="mt-1 rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-slate-700 whitespace-pre-line">{s.edu.body}</p></details>}
    </section>
  );
}

export default function HealthReportView({ report, fileHref, consultUrl, pdfHref }: { report: Report; fileHref: (resultId: number) => string; consultUrl: string | null; pdfHref?: string }) {
  const h = report.header, sm = report.summary;
  const totalRows = report.sections.reduce((n, x) => n + x.rows.length, 0);
  return (
    <article className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <div className="text-brand font-extrabold text-3xl leading-none whitespace-nowrap">Health <span className="text-base font-bold">Check up report</span></div>
          <div className="text-brand text-base">รายงานผลการตรวจสุขภาพ</div>
        </div>
        {consultUrl && <a href={consultUrl} target="_blank" rel="noopener" className="shrink-0 sm:text-right rounded-xl nk-gradient text-white px-3 py-2 min-h-[44px] self-start"><div className="font-bold text-sm">ปรึกษาแพทย์ได้ที่นี่</div><div className="text-[10px] opacity-80">Medical consultation available here</div></a>}
      </header>

      {/* summary card on top */}
      <section className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
        <div className="px-4 py-3 text-white nk-gradient">
          <div className="text-xs opacity-90">{report.roundName} · วันที่ตรวจ {thaiLongDate(h.examDate)}</div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5"><div className="text-xl font-extrabold leading-tight">{h.name}</div>{sm.overall.verdict && <div className={`rounded-full px-3 py-0.5 text-sm font-bold ${sm.overall.verdict === "ปกติ" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>ภาพรวม: {sm.overall.verdict}</div>}</div>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-white border border-slate-200 py-2"><div className="text-2xl font-extrabold text-brand tabular-nums">{totalRows}</div><div className="text-[11px] text-slate-600">รายการที่ตรวจ</div></div>
            <div className="rounded-xl bg-white border border-slate-200 py-2"><div className="text-2xl font-extrabold text-emerald-700 tabular-nums">{Math.max(0, totalRows - sm.abnormal.length)}</div><div className="text-[11px] text-slate-600">อยู่ในเกณฑ์</div></div>
            <div className="rounded-xl bg-white border border-slate-200 py-2"><div className={`text-2xl font-extrabold tabular-nums ${sm.abnormal.length ? "text-rose-700" : "text-slate-400"}`}>{sm.abnormal.length}</div><div className="text-[11px] text-slate-600">นอกเกณฑ์อ้างอิง</div></div>
          </div>
          <div>
            <div className="font-bold text-slate-900 mb-1">รายการที่ต้องใส่ใจ</div>
            {sm.abnormal.length === 0 ? <div className="text-sm text-emerald-800">ไม่พบรายการที่นอกเกณฑ์อ้างอิง</div> : (
              <ul className="space-y-1.5">{sm.abnormal.map((a, i) => (
                <li key={i} className="flex items-center justify-between gap-3 rounded-xl bg-white border border-rose-200 px-3 py-2 min-h-[44px]">
                  <div className="min-w-0"><div className="font-semibold text-sm text-slate-900 break-words">{a.name}</div><div className="text-[11px] text-slate-500">{a.section}</div></div>
                  <div className="text-right shrink-0"><div className="font-bold text-slate-900">{a.value}</div><div className="text-xs font-semibold text-rose-700">{withArrow(a.word)}</div></div>
                </li>
              ))}</ul>
            )}
          </div>
          {sm.recommendations.length > 0 && <div><div className="font-bold text-slate-900">คำแนะนำของแพทย์</div><ul className="text-sm text-slate-800 space-y-1 whitespace-pre-line mt-1">{sm.recommendations.map((r, i) => <li key={i} className="pl-3 -indent-3">- {r}</li>)}</ul></div>}
          <div className="flex flex-wrap gap-2">
            {consultUrl && <a href={consultUrl} target="_blank" rel="noopener" className="inline-flex items-center justify-center min-h-[44px] px-5 rounded-xl nk-gradient text-white font-semibold text-sm flex-1 sm:flex-none">ปรึกษาแพทย์</a>}
            {pdfHref && <a href={pdfHref} target="_blank" rel="noopener" className="inline-flex items-center justify-center min-h-[44px] px-5 rounded-xl border border-brand bg-white text-brand font-semibold text-sm flex-1 sm:flex-none">ดาวน์โหลดเล่มผล PDF</a>}
          </div>
        </div>
      </section>

      {/* jump to a section (sticks to the top while scrolling) */}
      {report.sections.length > 1 && (
        <nav aria-label="ไปยังหมวด" className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-white/95 backdrop-blur border-b border-slate-200 print:hidden">
          <ul className="flex gap-2 overflow-x-auto no-scrollbar">
            {report.sections.map((x) => <li key={x.key} className="shrink-0"><a href={`#sec-${x.key}`} className="inline-flex items-center min-h-[44px] px-3 rounded-full border border-slate-300 bg-white text-sm text-brand whitespace-nowrap">{x.th}</a></li>)}
          </ul>
        </nav>
      )}

      {/* general information */}
      <section className="space-y-3">
        <Bar>รายงานผลการตรวจสุขภาพ <span className="font-normal opacity-90">· Health check up report</span></Bar>
        <dl className="rounded-xl bg-white border border-slate-200 shadow-card px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          {[["วันที่ตรวจสุขภาพ", thaiLongDate(h.examDate)], ["ชื่อ - นามสกุล", h.name], ["อายุ", h.age != null ? `${h.age} ปี` : "—"], ["ชื่อบริษัท", h.company ? glueCompany(h.company) : "—"], ["รหัสพนักงาน", h.employeeCode ?? "—"], ["ตำแหน่ง", h.position ?? "—"], ["แผนก", h.department ?? "—"]].map(([k, v]) => (
            <div key={k} className="flex gap-2"><dt className="text-slate-500 shrink-0">{k}:</dt><dd className="font-semibold text-slate-900 break-words">{v}</dd></div>
          ))}
        </dl>
      </section>

      {report.sections.map((s) => <Section key={s.key} s={s} years={report.years} fileHref={fileHref} />)}

      <footer className="border-t border-slate-200 pt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/health-report/logos.png" alt="AT HOME CLINIC · OMNIA HEALTH" className="h-10 w-auto" />
        <div className="text-right"><div className="font-semibold text-brand">@athomeclinic.bowin</div><div>Every moment matters</div><div>Precision Health • Less Waiting</div></div>
      </footer>
    </article>
  );
}
