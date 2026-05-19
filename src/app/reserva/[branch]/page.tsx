import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { getChannelByCode } from "@/lib/messaging-channels";
import LangToggle from "../../LangToggle";
import Footer from "../../Footer";
import BookingForm from "./BookingForm";

export const dynamic = "force-dynamic";

export default function BookPage({ params }: { params: { branch: string } }) {
  const lang = getLang();
  const branch = getDb().prepare("SELECT * FROM branches WHERE slug = ?").get(params.branch) as Branch | undefined;
  if (!branch) notFound();
  // LIFF ID for this branch's booking page (if admin has set it). When
  // present, BookingForm loads the LIFF SDK and auto-captures the customer's
  // LINE userId so they can receive the booking-confirmation Flex card.
  const channel = getChannelByCode(branch.slug);
  const liffId = channel?.liff_id ?? null;
  return (
    <div className="min-h-screen flex flex-col bg-slate-100">
      <main className="flex-1">
        <div className="bg-ink-gradient text-white py-6 px-6">
          <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
            <Link href="/reserva" className="inline-block hover:opacity-80 transition-opacity">
              <div className="brand-wordmark text-white text-xl">
                IKIGAI OS <span className="text-white/60 font-normal text-sm tracking-normal">· RESERVA</span>
              </div>
            </Link>
            <LangToggle variant="dark" />
          </div>
        </div>
        <div className="max-w-2xl mx-auto p-4 sm:p-6">
          <Link href="/reserva" className="text-sm text-slate-500 hover:text-brand inline-flex items-center gap-1 mb-3">
            {t(lang, "customer.reserva.chooseAnotherBranch")}
          </Link>
          <header className="mb-6">
            <h1 className="text-2xl font-bold text-slate-800">{branch.name}</h1>
            {branch.status === "open" && (
              <p className="text-slate-500 text-sm mt-1">
                {t(lang, "customer.reserva.formIntro", { open: branch.open_time, close: branch.close_time })}
              </p>
            )}
          </header>
          {branch.status === "open" ? (
            <BookingForm branch={branch} liffId={liffId} />
          ) : (
            <div className="card text-center py-10 space-y-2">
              <p className="text-lg font-bold text-slate-800">
                {branch.status === "closed"
                  ? t(lang, "customer.reserva.closedBadge")
                  : t(lang, "customer.reserva.comingSoonBadge")}
              </p>
              <p className="text-sm text-slate-500">
                {branch.status === "closed"
                  ? t(lang, "customer.reserva.closedMsg")
                  : branch.opens_on
                    ? t(lang, "customer.reserva.opensOn", { date: branch.opens_on })
                    : t(lang, "customer.reserva.opensSoon")}
              </p>
              <Link href="/reserva" className="inline-block mt-2 text-brand font-bold hover:underline">
                {t(lang, "customer.reserva.chooseAnotherBranch")}
              </Link>
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
