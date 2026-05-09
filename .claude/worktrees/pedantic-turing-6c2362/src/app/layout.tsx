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
  return (
    <html lang={lang}>
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/lazywasabi/thai-web-fonts@7/fonts/LINESeedSansTH/LINESeedSansTH.css"
        />
      </head>
      <body>
        <LangProvider lang={lang}>{children}</LangProvider>
      </body>
    </html>
  );
}
