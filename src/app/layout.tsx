import type { Metadata } from "next";
import "./globals.css";
import { LangProvider } from "@/lib/LangProvider";
import { getLang } from "@/lib/lang-server";

export const metadata: Metadata = {
  title: {
    default: "IKIGAI OS",
    template: "%s · IKIGAI OS"
  },
  description: "ระบบจัดการธุรกิจ"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = getLang();
  // Font face declarations live in globals.css (self-hosted woff2
  // under /public/fonts). No external <link> needed — the previous
  // jsdelivr CDN had ~20s first-byte from Thai networks which left
  // headers/footers rendering in the system fallback while the user
  // waited. Local files are bundled with the build and served from
  // the same origin.
  return (
    <html lang={lang}>
      <body>
        <LangProvider lang={lang}>{children}</LangProvider>
      </body>
    </html>
  );
}
