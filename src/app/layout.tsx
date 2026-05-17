import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { LangProvider } from "@/lib/LangProvider";
import { getLang } from "@/lib/lang-server";
import TitleUppercase from "./components/TitleUppercase";

// Self-hosted LINE Seed Sans TH wired through next/font/local. The
// font files live under /public/fonts/. We point at them via a
// relative path so Next.js can fingerprint + serve them from
// /_next/static/media/ during build, which buys us:
//   1. Auto-emitted <link rel="preload"> on the HTML head — the
//      browser starts fetching the woff2 in parallel with HTML
//      instead of waiting for CSS to be parsed first (the bottleneck
//      with raw @font-face in globals.css).
//   2. size-adjust + ascent-override applied automatically so the
//      system fallback during font swap renders at the same
//      effective height — kills the CLS jump.
//   3. font-display: swap baked in so we never FOIT-block the page.
//
// Exposed as a CSS variable (--font-lineseed) consumed by
// tailwind.config.ts's fontFamily.sans and globals.css's :root.
const lineSeed = localFont({
  src: [
    {
      path: "../../public/fonts/LINESeedSansTH-Regular.woff2",
      weight: "400",
      style: "normal"
    },
    {
      path: "../../public/fonts/LINESeedSansTH-Bold.woff2",
      weight: "700",
      style: "normal"
    },
    {
      path: "../../public/fonts/LINESeedSansTH-ExtraBold.woff2",
      weight: "800",
      style: "normal"
    }
  ],
  variable: "--font-lineseed",
  display: "swap",
  preload: true,
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"]
});

export const metadata: Metadata = {
  title: {
    default: "IKIGAI OS",
    template: "%s · IKIGAI OS"
  },
  description: "ระบบจัดการธุรกิจ"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = getLang();
  return (
    <html lang={lang} className={lineSeed.variable}>
      <body className={lineSeed.className}>
        <TitleUppercase />
        <LangProvider lang={lang}>{children}</LangProvider>
      </body>
    </html>
  );
}
