import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { getChannelByCode } from "@/lib/messaging-channels";
import LangToggle from "../../LangToggle";
import Footer from "../../Footer";
import BookingForm from "./BookingForm";

export const dynamic = "force-dynamic";

/** Detect whether the request came from inside the LINE in-app
 *  browser. The LINE app stamps its UA with a `Line/<version>` token
 *  on both iOS and Android — checking that is far more reliable than
 *  the LIFF JS SDK, because the SDK only knows once it's loaded and
 *  we want to gate UI at server-render time. False positives are
 *  near-zero (no other widely-deployed browser identifies as "Line/").
 *
 *  When in-LINE: hide the "choose another branch" navigation so a
 *  customer who tapped a HYPO LINE chat link can't accidentally book
 *  at NAMA. Outside LINE (Safari, Chrome, Google Reserve, direct URL)
 *  the branch picker stays available as normal. */
function isFromLineApp(): boolean {
  const ua = headers().get("user-agent") ?? "";
  return /\bLine\/\d/i.test(ua);
}

export default function BookPage({ params }: { params: { branch: string } }) {
  const lang = getLang();
  const branch = getDb().prepare("SELECT * FROM branches WHERE slug = ?").get(params.branch) as Branch | undefined;
  if (!branch) notFound();
  // LIFF ID for this branch's booking page (if admin has set it). When
  // present, BookingForm loads the LIFF SDK and auto-captures the customer's
  // LINE userId so they can receive the booking-confirmation Flex card.
  const channel = getChannelByCode(branch.slug);
  const liffId = channel?.liff_id ?? null;
  const lineLocked = isFromLineApp();
  return (
    <div className="min-h-screen flex flex-col bg-slate-100">
      <main className="flex-1">
        <div className="bg-ink-gradient text-white py-6 px-6">
          <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
            {/* When the customer came via the branch's LINE OA we
                strip the back-to-list link off the IKIGAI OS wordmark
                too — they should stay locked to the branch that owns
                the LINE channel. Outside LINE the wordmark stays a
                normal link back to /reserva. */}
            {lineLocked ? (
              <div className="brand-wordmark text-white text-xl">
                IKIGAI OS <span className="text-white/60 font-normal text-sm tracking-normal">· RESERVA</span>
              </div>
            ) : (
              <Link href="/reserva" className="inline-block hover:opacity-80 transition-opacity">
                <div className="brand-wordmark text-white text-xl">
                  IKIGAI OS <span className="text-white/60 font-normal text-sm tracking-normal">· RESERVA</span>
                </div>
              </Link>
            )}
            <LangToggle variant="dark" />
          </div>
        </div>
        <div className="max-w-2xl mx-auto p-4 sm:p-6">
          {/* Hide the "choose another branch" link entirely for
              in-LINE traffic — that's the whole point of the lock. */}
          {!lineLocked && (
            <Link href={`/reserva?from=${branch.slug}`} className="text-sm text-slate-500 hover:text-brand inline-flex items-center gap-1 mb-3">
              {t(lang, "customer.reserva.chooseAnotherBranch")}
            </Link>
          )}
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
              {/* Hide the branch-switch link in-LINE too — even for
                  closed/coming-soon branches the customer should
                  stay parked at this branch until staff replies. */}
              {!lineLocked && (
                <Link href={`/reserva?from=${branch.slug}`} className="inline-block mt-2 text-brand font-bold hover:underline">
                  {t(lang, "customer.reserva.chooseAnotherBranch")}
                </Link>
              )}
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
