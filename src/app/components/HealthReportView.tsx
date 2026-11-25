import type { Report, RSection } from "@/lib/health-report/report";
import { withArrow } from "@/lib/health-report/interpret";

// The health check-up report on screen (mobile first): navy section bars, grey striped rows, cream boxes, the three years side by side.
// A flag is always a WORD (สูง / ต่ำ / ผิดปกติ) next to the colour, never colour alone. Server component: nothing here fetches.

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
export const thaiLongDate = (iso: string | null | undefined) => { if (!iso) return "—"; const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`; };
const NAVY = "bg-[#0B1F3A]";

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
    <section className="space-y-3" id={`sec-${s.key}`}>
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
      {s.lines.length > 0 && <div className="rounded-xl bg-[#FBF6E9] border border-[#EBDDB4] px-4 py-3 text-sm text-slate-800 space-y-1"><div className="font-bold">สรุปผลจากระบบ</div>{s.lines.map((l, i) => <div key={i}>- {l}</div>)}</div>}
      {s.file && <a href={fileHref(s.file.resultId)} target="_blank" rel="noopener" className="inline-flex items-center min-h-[44px] px-4 rounded-lg border border-slate-300 text-sm text-brand underline">เปิดภาพ/ไฟล์ผลตรวจ</a>}
      {s.note && (
        <div className="rounded-xl bg-[#FBF6E9] border border-[#EBDDB4] px-4 py-3 text-sm text-slate-800 space-y-2">
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
  return (
    <article className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <div className="text-[#0B1F3A] font-extrabold text-3xl leading-none whitespace-nowrap">Health <span className="text-base font-bold">Check up report</span></div>
          <div className="text-[#0B1F3A] text-base">รายงานผลการตรวจสุขภาพ</div>
        </div>
        {consultUrl && <a href={consultUrl} target="_blank" rel="noopener" className="shrink-0 sm:text-right rounded-xl bg-[#0B1F3A] text-white px-3 py-2 min-h-[44px] self-start"><div className="font-bold text-sm">ปรึกษาแพทย์ได้ที่นี่</div><div className="text-[10px] opacity-80">Medical consultation available here</div></a>}
      </header>

      {/* summary card on top */}
      <section className="rounded-2xl bg-[#FBF6E9] border border-[#EBDDB4] p-4 space-y-3">
        <div className="text-sm text-slate-600">{report.roundName} · วันที่ตรวจ {thaiLongDate(h.examDate)}</div>
        <div className="flex flex-wrap items-baseline gap-x-3"><div className="text-xl font-bold text-slate-900">{h.name}</div>{sm.overall.verdict && <span className={`rounded-full px-3 py-0.5 text-sm font-semibold ${sm.overall.verdict === "ปกติ" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>ภาพรวม: {sm.overall.verdict}</span>}</div>
        <div>
          <div className="font-bold text-slate-900">รายการที่ผิดปกติ ({sm.abnormal.length})</div>
          {sm.abnormal.length === 0 ? <div className="text-sm text-emerald-800">ไม่พบรายการที่นอกเกณฑ์อ้างอิง</div> : (
            <ul className="text-sm text-slate-800 space-y-0.5">{sm.abnormal.map((a, i) => <li key={i}><b>{a.name}</b> {a.value} <span className="text-rose-700 font-semibold">({withArrow(a.word)})</span> <span className="text-xs text-slate-500">— {a.section}</span></li>)}</ul>
          )}
        </div>
        {sm.recommendations.length > 0 && <div><div className="font-bold text-slate-900">คำแนะนำของแพทย์</div><ul className="text-sm text-slate-800 space-y-1 whitespace-pre-line">{sm.recommendations.map((r, i) => <li key={i}>- {r}</li>)}</ul></div>}
        <div className="flex flex-wrap gap-2">
          {consultUrl && <a href={consultUrl} target="_blank" rel="noopener" className="inline-flex items-center justify-center min-h-[44px] px-5 rounded-xl bg-[#0B1F3A] text-white font-semibold text-sm">ปรึกษาแพทย์</a>}
          {pdfHref && <a href={pdfHref} target="_blank" rel="noopener" className="inline-flex items-center justify-center min-h-[44px] px-5 rounded-xl border border-[#0B1F3A] text-[#0B1F3A] font-semibold text-sm">ดาวน์โหลดเล่มผล PDF</a>}
        </div>
      </section>

      {/* general information */}
      <section className="space-y-3">
        <Bar>รายงานผลการตรวจสุขภาพ <span className="font-normal opacity-90">· Health check up report</span></Bar>
        <dl className="rounded-xl bg-[#FBF6E9] border border-[#EBDDB4] px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          {[["วันที่ตรวจสุขภาพ", thaiLongDate(h.examDate)], ["ชื่อ - นามสกุล", h.name], ["อายุ", h.age != null ? `${h.age} ปี` : "—"], ["ชื่อบริษัท", h.company ?? "—"], ["รหัสพนักงาน", h.employeeCode ?? "—"], ["ตำแหน่ง", h.position ?? "—"], ["แผนก", h.department ?? "—"]].map(([k, v]) => (
            <div key={k} className="flex gap-2"><dt className="text-slate-500 shrink-0">{k}:</dt><dd className="font-semibold text-slate-900 break-words">{v}</dd></div>
          ))}
        </dl>
      </section>

      {report.sections.map((s) => <Section key={s.key} s={s} years={report.years} fileHref={fileHref} />)}

      <footer className="border-t border-slate-200 pt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/health-report/logos.png" alt="AT HOME CLINIC · OMNIA HEALTH" className="h-10 w-auto" />
        <div className="text-right"><div className="font-semibold text-[#0B1F3A]">@athomeclinic.bowin</div><div>Every moment matters</div><div>Precision Health • Less Waiting</div></div>
      </footer>
    </article>
  );
}
