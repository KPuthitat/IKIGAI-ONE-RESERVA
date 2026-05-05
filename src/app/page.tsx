import Link from "next/link";

// IKIGAI OS Portal — รวมทางเข้าทุก module ในที่เดียว
// /reserva/        → portal นี้ (สำหรับเจ้าของ + พนักงาน)
// /reserva/admin   → RESERVA module (จัดการการจองโต๊ะ)
// /payroll/login   → PERSONA module (ระบบบริหารงานบุคคล) — Express app แยก
// /reserva/book    → หน้าจองโต๊ะของลูกค้า

export default function PortalPage() {
  return (
    <main className="min-h-screen bg-ink-gradient flex flex-col items-center justify-center p-6">
      <div className="text-center mb-8">
        <div className="brand-wordmark text-white text-[42px]">IKIGAI OS</div>
        <div className="text-white/50 text-[13px] tracking-[1px] mt-1">
          ระบบจัดการธุรกิจ
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 max-w-2xl w-full">
        <a
          href="/payroll/login"
          className="card hover:shadow-2xl transition group block"
        >
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">MODULE</div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            PERSONA
          </h2>
          <p className="text-slate-500 text-sm mt-1">ระบบบริหารงานบุคคล</p>
          <p className="mt-4 text-brand font-bold text-sm">เข้าใช้งาน →</p>
        </a>

        <Link href="/admin" className="card hover:shadow-2xl transition group block">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">MODULE</div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            RESERVA
          </h2>
          <p className="text-slate-500 text-sm mt-1">ระบบจองโต๊ะร้านอาหาร</p>
          <p className="mt-4 text-brand font-bold text-sm">เข้าใช้งาน →</p>
        </Link>
      </div>

      <div className="text-center mt-10 border-t border-white/10 pt-6 max-w-2xl w-full">
        <div className="text-white/40 text-[11px] tracking-[1px] mb-2">FOR CUSTOMERS</div>
        <Link
          href="/book"
          className="inline-block text-white/80 hover:text-white text-sm border border-white/20 rounded-full px-5 py-2 transition-colors"
        >
          จองโต๊ะ — สำหรับลูกค้า →
        </Link>
      </div>
    </main>
  );
}
