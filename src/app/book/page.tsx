import Link from "next/link";
import { getDb, type Branch } from "@/lib/db";

export const dynamic = "force-dynamic";

// หน้าเลือกสาขาสำหรับลูกค้า — เข้าผ่าน /reserva/book
export default function BookHomePage() {
  const branches = getDb().prepare("SELECT * FROM branches ORDER BY name").all() as Branch[];
  return (
    <main className="min-h-screen bg-ink-gradient flex flex-col items-center justify-center p-6">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-8">
          <div className="brand-wordmark text-white text-[42px]">IKIGAI OS</div>
          <div className="text-white/50 text-[13px] tracking-[1px] mt-1">RESERVA</div>
          <p className="text-white/70 mt-4">เลือกสาขาที่ต้องการจองโต๊ะ</p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          {branches.map((b) => (
            <Link
              key={b.id}
              href={`/book/${b.slug}`}
              className="card hover:shadow-2xl transition group block"
            >
              <h2 className="text-xl font-bold text-slate-800 group-hover:text-brand transition-colors">
                {b.name}
              </h2>
              <p className="text-slate-500 text-sm mt-1">
                เปิด {b.open_time} – {b.close_time} น.
              </p>
              <p className="mt-3 text-brand font-bold">จองโต๊ะ →</p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
