import type { Metadata } from "next";
import LoginForm from "./LoginForm";
import LangToggle from "../LangToggle";
import Footer from "../Footer";
import OwlMascot from "../components/OwlMascot";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เข้าระบบ" };

// Login page (2026-05-31 CI refresh).
//
// New layout principles vs the pre-refresh page:
//   • Owl mascot is the visual anchor at the top. It's the brand
//     ambassador the staff already recognise from the shift-reminder
//     card and the maintenance page; putting it at the front door
//     makes the moment of "I'm at work" feel familiar.
//   • A single welcome line in the user's language sits below the
//     mascot ("ยินดีต้อนรับสู่ IKIGAI OS" / "Welcome to IKIGAI OS").
//   • Form retains the dark ink gradient + glass card + brand-red
//     accent — those are working well, just rebalanced around the
//     mascot.
//   • Subtle decorative orbs in the background give the page a bit
//     more depth without competing for attention.

export default function LoginPage({
  searchParams
}: { searchParams: { next?: string; error?: string } }) {
  const lang = getLang();
  return (
    <div className="min-h-screen flex flex-col bg-ink-gradient relative overflow-hidden">
      {/* Background ambient orbs — purely decorative. Use the brand
          coral + a deeper navy to keep the colour story tight. */}
      <div
        aria-hidden
        className="absolute -top-32 -left-32 w-[480px] h-[480px] rounded-full opacity-[0.12] blur-3xl pointer-events-none"
        style={{ background: "radial-gradient(circle, #e94560 0%, transparent 70%)" }}
      />
      <div
        aria-hidden
        className="absolute -bottom-40 -right-32 w-[520px] h-[520px] rounded-full opacity-[0.10] blur-3xl pointer-events-none"
        style={{ background: "radial-gradient(circle, #fda4af 0%, transparent 70%)" }}
      />

      <main className="flex-1 flex flex-col items-center px-6 pt-[8vh] pb-6 relative z-10">
        {/* Owl + brand block */}
        <div className="text-center mb-6 max-w-sm w-full">
          <div className="inline-block animate-owl-float">
            <OwlMascot
              size={140}
              mood="smile"
              ariaLabel="IKIGAI OS"
              className="mx-auto drop-shadow-[0_8px_20px_rgba(233,69,96,0.25)]"
            />
          </div>
          <div className="brand-wordmark text-white text-[38px] leading-none mt-3">
            IKIGAI OS
          </div>
          <p className="text-white/60 text-xs tracking-[1px] uppercase mt-2 font-semibold">
            {lang === "en" ? "Powered by IKIGAI MEDIHEALTH" : "ระบบบริหารธุรกิจครบวงจร"}
          </p>
          <p className="text-white/80 text-sm mt-3 leading-snug">
            {lang === "en"
              ? "Welcome — sign in to continue 🦉"
              : "ยินดีต้อนรับ — เข้าระบบเพื่อใช้งาน 🦉"}
          </p>
        </div>

        <LoginForm next={searchParams.next} error={searchParams.error} />

        <div className="mt-6 flex items-center gap-4">
          <LangToggle variant="dark" />
        </div>

        {/* Subtle support hint at the bottom of the active area */}
        <div className="mt-8 text-center text-[11px] text-white/40 max-w-sm leading-relaxed">
          {lang === "en"
            ? "Need help signing in? Tap the owl helper inside the app once you’re in, or ask your admin."
            : t(lang, "login.helpHint")}
        </div>
      </main>

      <Footer />
    </div>
  );
}
