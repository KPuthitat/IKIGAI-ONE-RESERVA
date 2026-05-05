import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IKIGAI OS RESERVA",
  description: "ระบบจองโต๊ะ NAMA PASTA SRIRACHA / HYPOPLARAEMIA"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/lazywasabi/thai-web-fonts@7/fonts/LINESeedSansTH/LINESeedSansTH.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
