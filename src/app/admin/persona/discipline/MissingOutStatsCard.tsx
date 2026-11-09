import type { MissingOutStats } from "@/lib/missing-out";

const MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const monLabel = (ym: string) => `${MON[Number(ym.slice(5, 7)) - 1]} ${String((Number(ym.slice(0, 4)) + 543) % 100).padStart(2, "0")}`;

// Statistics of forgotten clock-outs (owner 2026-11-09): how often, who, how it was caught, and how
// fast the warning letter gets acknowledged (clock-in stays blocked until then).
export default function MissingOutStatsCard({ stats, months }: { stats: MissingOutStats; months: number }) {
  const max = Math.max(1, ...stats.byMonth.map((m) => m.count));
  const tile = (label: string, value: string, tone = "text-slate-800") => (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
  return (
    <div className="card space-y-3">
      <div>
        <h2 className="font-bold text-slate-800 text-sm">สถิติการลืมลงเวลาออกงาน · {months} เดือนล่าสุด</h2>
        <p className="text-[11px] text-slate-500 mt-0.5">คนที่ไม่ลงเวลาออก จะลงเวลาเข้างานครั้งถัดไปไม่ได้จนกว่าจะกดรับทราบหนังสือเตือน · วันถัดไปไม่มีกะ ระบบส่งหนังสือให้ตั้งแต่ 13:00 น. · หนังสือที่ยกเลิกแล้วไม่นับ</p>
      </div>
      {stats.total === 0 ? <p className="text-xs text-slate-400">ยังไม่มีการลืมลงเวลาออกในช่วงนี้</p> : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {tile("ลืมลงเวลาออก (ครั้ง)", String(stats.total))}
            {tile("รับทราบแล้ว", String(stats.acknowledged), "text-emerald-700")}
            {tile("ยังไม่รับทราบ (ลงเวลาเข้าไม่ได้)", String(stats.pending), stats.pending ? "text-rose-600" : "text-slate-800")}
            {tile("เวลาเฉลี่ยกว่าจะรับทราบ", stats.avgHoursToAck == null ? "—" : `${stats.avgHoursToAck} ชม.`)}
            {tile("พบตอนกดลงเวลาเข้า", String(stats.viaClockIn))}
            {tile("ส่งหนังสือช่วงบ่าย (ไม่มีกะ)", String(stats.viaAfternoon))}
            {tile("ถูกบล็อกตอนลงเวลาเข้า (ครั้ง)", String(stats.blockedAttempts))}
            {tile("ส่งหนังสือทาง LINE แล้ว", String(stats.lettersSent))}
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-semibold text-slate-700 mb-1">รายเดือน</div>
              <div className="space-y-1">
                {stats.byMonth.map((m) => (
                  <div key={m.month} className="flex items-center gap-2 text-xs">
                    <span className="w-14 text-slate-500">{monLabel(m.month)}</span>
                    <span className="h-3 rounded bg-rose-300" style={{ width: `${Math.round((m.count / max) * 100)}%`, minWidth: m.count ? 4 : 0 }} />
                    <span className="tabular-nums text-slate-700">{m.count}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-700 mb-1">รายคน (มากสุด 10 อันดับ)</div>
              <table className="w-full text-xs">
                <thead><tr className="text-slate-400 text-left"><th className="font-normal">พนักงาน</th><th className="font-normal text-right">ครั้ง</th><th className="font-normal text-right">ค้างรับทราบ</th><th className="font-normal text-right">ล่าสุด</th></tr></thead>
                <tbody>
                  {stats.byPerson.map((p) => (
                    <tr key={p.userId} className="border-t border-slate-100">
                      <td className="py-1">{p.name}</td>
                      <td className="py-1 text-right tabular-nums font-semibold">{p.count}</td>
                      <td className={`py-1 text-right tabular-nums ${p.pending ? "text-rose-600 font-semibold" : "text-slate-400"}`}>{p.pending || "—"}</td>
                      <td className="py-1 text-right text-slate-500">{p.last}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
