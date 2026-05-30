import type { Metadata } from "next";
import LoginForm from "./LoginForm";
import LangToggle from "../LangToggle";
import Footer from "../Footer";
import OwlMascot from "../components/OwlMascot";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เข้าระบบ" };

// Login page (2026-05-31 CI v2 — owl-on-light-card to match LIFF).
//
// Earlier CI revision used a dark ink gradient + owl floating loose
// on top. Owner direction: align with the LIFF portal aesthetic —
// soft amber background + single white card centred, owl sitting on
// top of the card. Reads as the same "friendly visit" UI staff
// already recognise from the LINE entry, just for the browser path.
//
// Layout:
//   • bg-amber-50/40 base (same as /persona/portal)
//   • Centered card: owl 140 → IKIGAI OS wordmark → welcome line →
//     role selector → username/password form → submit button
//   • LangToggle sits outside the card (subtler that way)
//   • Footer stays at page bottom

export default function LoginPage({
  searchParams
}: { searchParams: { next?: string; error?: string } }) {
  const lang = getLang();
  return (
    <div className="min-h-screen flex flex-col bg-amber-50/40">
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-8">
        {/* Single white card holds everything — matches LIFF portal */}
        <div className="card max-w-md w-full text-center space-y-3">
          <div className="inline-block animate-owl-float">
            <OwlMascot
              size={140}
              mood="smile"
              ariaLabel="IKIGAI OS"
              className="mx-auto block"
            />
          </div>
          <div className="brand-wordmark text-slate-800 text-[32px] leading-none">
            IKIGAI OS
          </div>
          <p className="text-slate-400 text-[11px] tracking-[1.5px] uppercase font-semibold">
            {lang === "en" ? "Powered by IKIGAI MEDIHEALTH" : "ระบบบริหารธุรกิจครบวงจร"}
          </p>
          <p className="text-slate-600 text-sm leading-snug">
            {lang === "en"
              ? "Welcome — sign in to continue 🦉"
              : "ยินดีต้อนรับ — เข้าระบบเพื่อใช้งาน 🦉"}
          </p>

          {/* Form lives inside the same card — keeps the visual
              footprint single instead of stacking "title card" +
              "form card" which read as two separate ideas. */}
          <div className="pt-3 text-left">
            <LoginForm next={searchParams.next} error={searchParams.error} />
          </div>
        </div>

        <div className="mt-6 flex items-center gap-4">
          <LangToggle variant="light" />
        </div>

        {/* Subtle support hint at the bottom of the active area */}
        <div className="mt-6 text-center text-[11px] text-slate-400 max-w-sm leading-relaxed">
          {lang === "en"
            ? "Need help signing in? Tap the owl helper inside the app once you're in, or ask your admin."
            : t(lang, "login.helpHint")}
        </div>
      </main>

      <Footer />
    </div>
  );
}
