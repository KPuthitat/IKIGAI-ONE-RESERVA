import Link from "next/link";
import type { Metadata } from "next";
import { getDb, type Branch } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "จองโต๊ะ · RESERVA" };

// /reserva — หน้าจองของลูกค้า เน้น NAMA เป็นหลัก
export default function CustomerReservaPage() {
  const branches = getDb().prepare("SELECT * FROM branches ORDER BY name").all() as Branch[];
  const nama = branches.find((b) => b.slug === "nama-sriracha");
  const others = branches.filter((b) => b.slug !== "nama-sriracha");

  return (
    <main className="min-h-screen bg-ink-gradient flex flex-col items-center justify-center p-6">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-8">
          <div className="brand-wordmark text-white text-[42px]">IKIGAI OS</div>
          <div className="text-white/50 text-[13px] tracking-[1px] mt-1">RESERVA</div>
          <p className="text-white/70 mt-4">จองโต๊ะร้านอาหาร</p>
        </div>

        {/* NAMA primary */}
        {nama && (
          <Link
            href={`/reserva/${nama.slug}`}
            className="card hover:shadow-2xl transition group block mb-3"
          >
            <div className="text-[11px] tracking-[2px] text-brand font-bold mb-1">FEATURED</div>
            <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
              {nama.name}
            </h2>
            <p className="text-slate-500 text-sm mt-1">
              เปิดบริการ {nama.open_time} – {nama.close_time} น.
            </p>
            <p className="mt-4 text-brand font-bold">จองโต๊ะ →</p>
          </Link>
        )}

        {/* others — แบบเล็ก */}
        {others.length > 0 && (
          <div className="grid sm:grid-cols-2 gap-3">
            {others.map((b) => (
              <Link
                key={b.id}
                href={`/reserva/${b.slug}`}
                className="bg-white/[.06] hover:bg-white/[.1] border border-white/[.12] rounded-2xl p-5 transition block"
              >
                <h3 className="text-white font-bold">{b.name}</h3>
                <p className="text-white/60 text-xs mt-1">
                  {b.open_time} – {b.close_time} น.
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
