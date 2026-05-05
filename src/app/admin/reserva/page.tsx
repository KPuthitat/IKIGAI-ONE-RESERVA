import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type Booking } from "@/lib/db";
import { todayBkk } from "@/lib/time";

export const dynamic = "force-dynamic";

export default function ReservaDashboardPage() {
  const user = requireUser();
  if (!user.activeBranchId) {
    return <div className="card">บัญชีของคุณยังไม่ได้รับสิทธิ์เข้าสาขาใดๆ ติดต่อแอดมิน</div>;
  }
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(user.activeBranchId) as Branch;
  const today = todayBkk();

  const todays = db.prepare(`
    SELECT * FROM bookings WHERE branch_id = ? AND booking_date = ?
    ORDER BY booking_time ASC
  `).all(branch.id, today) as Booking[];

  const counts = {
    total: todays.length,
    confirmed: todays.filter((b) => b.status === "confirmed").length,
    seated: todays.filter((b) => b.status === "seated").length,
    no_show: todays.filter((b) => b.status === "no_show").length,
    cancelled: todays.filter((b) => b.status === "cancelled").length,
    guests: todays.filter((b) => b.status !== "cancelled").reduce((s, b) => s + b.party_size, 0)
  };

  const weekStats = db.prepare(`
    SELECT booking_date, COUNT(*) AS bookings, SUM(party_size) AS guests,
           SUM(CASE WHEN status='no_show' THEN 1 ELSE 0 END) AS no_shows
    FROM bookings
    WHERE branch_id = ? AND booking_date >= date(?, '-6 days') AND booking_date <= ?
    GROUP BY booking_date ORDER BY booking_date ASC
  `).all(branch.id, today, today) as Array<{ booking_date: string; bookings: number; guests: number; no_shows: number }>;

  const topSources = db.prepare(`
    SELECT je.value AS source, COUNT(*) AS n
    FROM bookings b, json_each(COALESCE(NULLIF(b.source, ''), '[]')) je
    WHERE b.branch_id = ? AND b.booking_date >= date(?, '-29 days')
    GROUP BY je.value ORDER BY n DESC LIMIT 8
  `).all(branch.id, today) as Array<{ source: string; n: number }>;
  const sourceTotal = topSources.reduce((s, x) => s + x.n, 0);

  const originStats = db.prepare(`
    SELECT COALESCE(customer_origin, '(ไม่ระบุ)') AS origin, COUNT(*) AS n
    FROM bookings
    WHERE branch_id = ? AND booking_date >= date(?, '-29 days')
    GROUP BY customer_origin ORDER BY n DESC
  `).all(branch.id, today) as Array<{ origin: string; n: number }>;

  const memberStats = db.prepare(`
    SELECT
      SUM(CASE WHEN is_member = 1 THEN 1 ELSE 0 END) AS members,
      SUM(CASE WHEN is_member = 0 THEN 1 ELSE 0 END) AS non_members,
      SUM(CASE WHEN is_member IS NULL THEN 1 ELSE 0 END) AS unknown
    FROM bookings
    WHERE branch_id = ? AND booking_date >= date(?, '-29 days')
  `).get(branch.id, today) as { members: number; non_members: number; unknown: number };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{branch.name}</h1>
        <p className="text-slate-500 text-sm">ภาพรวมวันนี้ · {today}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat label="จองทั้งหมด" value={counts.total} />
        <Stat label="รอลูกค้ามา" value={counts.confirmed} tone="blue" />
        <Stat label="นั่งแล้ว" value={counts.seated} tone="green" />
        <Stat label="ไม่มา" value={counts.no_show} tone="amber" />
        <Stat label="ยกเลิก" value={counts.cancelled} tone="slate" />
        <Stat label="แขกรวม" value={counts.guests} />
      </div>

      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">การจองวันนี้</h2>
          <Link href="/admin/reserva/bookings" className="text-brand text-sm hover:underline">ดูทั้งหมด →</Link>
        </div>
        {todays.length === 0 ? (
          <div className="text-slate-500 text-sm">ยังไม่มีการจองในวันนี้</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr><th className="py-2">เวลา</th><th>ลูกค้า</th><th>คน</th><th>โต๊ะ</th><th>สถานะ</th></tr>
              </thead>
              <tbody>
                {todays.map((b) => (
                  <tr key={b.id} className="border-t border-slate-100">
                    <td className="py-2 font-medium">{b.booking_time}</td>
                    <td>{b.customer_name}<div className="text-xs text-slate-500">{b.customer_phone}</div></td>
                    <td>{b.party_size}</td>
                    <td>
                      {b.table_id
                        ? (db.prepare("SELECT label FROM tables WHERE id = ?").get(b.table_id) as { label: string } | undefined)?.label ?? "—"
                        : "—"}
                    </td>
                    <td><span className={`px-2 py-0.5 rounded text-xs status-${b.status}`}>{statusLabel(b.status)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid md:grid-cols-2 gap-4">
        <section className="card">
          <h2 className="font-semibold mb-3">7 วันที่ผ่านมา</h2>
          <BarChart data={weekStats.map((d) => ({ label: d.booking_date.slice(5), value: d.bookings, sub: `${d.guests} แขก` }))} />
        </section>
        <section className="card">
          <h2 className="font-semibold mb-1">รู้จักร้านจากไหน (30 วัน)</h2>
          <p className="text-xs text-slate-500 mb-3">ลูกค้าตอบหลายข้อได้ — รวมการเลือกทั้งหมด</p>
          {topSources.length === 0 ? (
            <div className="text-slate-500 text-sm">ยังไม่มีข้อมูล</div>
          ) : (
            <ul className="space-y-2">
              {topSources.map((s) => {
                const pct = sourceTotal > 0 ? Math.round((s.n / sourceTotal) * 100) : 0;
                return (
                  <li key={s.source} className="text-sm">
                    <div className="flex justify-between mb-0.5">
                      <span>{s.source}</span>
                      <span className="text-slate-500">{s.n} · {pct}%</span>
                    </div>
                    <div className="bg-slate-100 rounded h-1.5 overflow-hidden">
                      <div className="bg-brand h-full" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card">
          <h2 className="font-semibold mb-3">ลูกค้าเดินทางมาจาก (30 วัน)</h2>
          {originStats.length === 0 ? (
            <div className="text-slate-500 text-sm">ยังไม่มีข้อมูล</div>
          ) : (
            <ul className="space-y-2">
              {originStats.map((o) => (
                <li key={o.origin} className="flex justify-between text-sm">
                  <span>{originLabel(o.origin)}</span>
                  <span className="text-slate-500">{o.n} ครั้ง</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2 className="font-semibold mb-3">สมาชิก vs ไม่ใช่สมาชิก (30 วัน)</h2>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div><div className="text-2xl font-bold text-emerald-600">{memberStats.members ?? 0}</div><div className="text-xs text-slate-500">เป็นสมาชิก</div></div>
            <div><div className="text-2xl font-bold text-amber-600">{memberStats.non_members ?? 0}</div><div className="text-xs text-slate-500">ยังไม่เคย</div></div>
            <div><div className="text-2xl font-bold text-slate-400">{memberStats.unknown ?? 0}</div><div className="text-xs text-slate-500">ไม่ระบุ</div></div>
          </div>
          {(memberStats.non_members ?? 0) > 0 && (
            <p className="text-xs text-slate-500 mt-3 border-t border-slate-100 pt-3">
              💡 มี {memberStats.non_members} คนที่ยังไม่ได้เป็นสมาชิก — ทีมงานควรชวนตอนถึงร้าน
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function originLabel(o: string): string {
  return ({ sriracha: "ศรีราชา", chonburi: "ชลบุรี (อื่นๆ)", other_province: "ต่างจังหวัด" } as Record<string, string>)[o] ?? o;
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const toneClass = tone === "blue" ? "text-blue-600" : tone === "green" ? "text-emerald-600" : tone === "amber" ? "text-amber-600" : tone === "slate" ? "text-slate-500" : "text-slate-900";
  return <div className="card text-center"><div className={`text-2xl font-bold ${toneClass}`}>{value}</div><div className="text-xs text-slate-500">{label}</div></div>;
}

function BarChart({ data }: { data: Array<{ label: string; value: number; sub?: string }> }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) return <div className="text-slate-500 text-sm">ยังไม่มีข้อมูล</div>;
  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.label} className="flex items-center text-xs gap-2">
          <span className="w-12 text-slate-500">{d.label}</span>
          <div className="flex-1 bg-slate-100 rounded h-5 overflow-hidden"><div className="bg-brand h-full" style={{ width: `${(d.value / max) * 100}%` }} /></div>
          <span className="w-20 text-right text-slate-600">{d.value} จอง {d.sub ? `· ${d.sub}` : ""}</span>
        </div>
      ))}
    </div>
  );
}

function statusLabel(s: string): string {
  return ({ confirmed: "รอลูกค้า", seated: "นั่งแล้ว", no_show: "ไม่มา", cancelled: "ยกเลิก", completed: "เสร็จสิ้น" } as Record<string, string>)[s] ?? s;
}
