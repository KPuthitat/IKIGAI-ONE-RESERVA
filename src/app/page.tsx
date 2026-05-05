import Link from "next/link";
import { getDb, type Branch } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const branches = getDb().prepare("SELECT * FROM branches ORDER BY name").all() as Branch[];
  return (
    <main className="min-h-screen p-6 flex flex-col items-center justify-center">
      <div className="max-w-2xl w-full">
        <h1 className="text-3xl font-bold mb-2 text-center">IKIGAI ONE RESERVA</h1>
        <p className="text-slate-600 text-center mb-8">เลือกสาขาที่ต้องการจองโต๊ะ</p>

        <div className="grid sm:grid-cols-2 gap-4">
          {branches.map((b) => (
            <Link
              key={b.id}
              href={`/book/${b.slug}`}
              className="card hover:border-brand hover:shadow-md transition group"
            >
              <h2 className="text-xl font-semibold group-hover:text-brand">{b.name}</h2>
              <p className="text-slate-500 text-sm mt-1">
                เปิด {b.open_time} – {b.close_time} น.
              </p>
              <p className="mt-3 text-brand font-medium">จองโต๊ะ →</p>
            </Link>
          ))}
        </div>

        <div className="text-center mt-10">
          <Link href="/admin" className="text-sm text-slate-500 hover:text-brand">
            สำหรับพนักงาน · เข้าระบบจัดการ
          </Link>
        </div>
      </div>
    </main>
  );
}
