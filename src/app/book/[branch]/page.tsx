import { notFound } from "next/navigation";
import { getDb, type Branch } from "@/lib/db";
import BookingForm from "./BookingForm";

export const dynamic = "force-dynamic";

export default function BookPage({ params }: { params: { branch: string } }) {
  const branch = getDb().prepare("SELECT * FROM branches WHERE slug = ?").get(params.branch) as Branch | undefined;
  if (!branch) notFound();
  return (
    <main className="min-h-screen p-4 sm:p-6 max-w-2xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">{branch.name}</h1>
        <p className="text-slate-600 text-sm">
          เปิดบริการ {branch.open_time} – {branch.close_time} น. · ระบบจะเลือกโต๊ะที่เหมาะสมที่สุดให้
        </p>
      </header>
      <BookingForm branch={branch} />
    </main>
  );
}
