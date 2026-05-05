import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, type Branch } from "@/lib/db";
import BookingForm from "./BookingForm";

export const dynamic = "force-dynamic";

export default function BookPage({ params }: { params: { branch: string } }) {
  const branch = getDb().prepare("SELECT * FROM branches WHERE slug = ?").get(params.branch) as Branch | undefined;
  if (!branch) notFound();
  return (
    <main className="min-h-screen bg-slate-100">
      <div className="bg-ink-gradient text-white py-6 px-6">
        <div className="max-w-2xl mx-auto text-center">
          <Link href="/book" className="inline-block hover:opacity-80 transition-opacity">
            <div className="brand-wordmark text-white text-xl">
              IKIGAI OS <span className="text-white/60 font-normal text-sm tracking-normal">· RESERVA</span>
            </div>
          </Link>
        </div>
      </div>
      <div className="max-w-2xl mx-auto p-4 sm:p-6">
        <Link href="/book" className="text-sm text-slate-500 hover:text-brand inline-flex items-center gap-1 mb-3">
          ← เลือกสาขาอื่น
        </Link>
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-800">{branch.name}</h1>
          <p className="text-slate-500 text-sm mt-1">
            เปิดบริการ {branch.open_time} – {branch.close_time} น. · ระบบจะเลือกโต๊ะที่เหมาะสมที่สุดให้
          </p>
        </header>
        <BookingForm branch={branch} />
      </div>
    </main>
  );
}
