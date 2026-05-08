// Staff-facing QR scanner. Opens the device camera (rear-facing on mobile),
// reads booking QR codes printed on the customer's LINE Flex card, and
// jumps to /r/<ref> for that booking. Useful when staff don't want to
// hand their phone over for the customer to show theirs.

import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import ScannerClient from "./ScannerClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "สแกนคิวอาร์โค้ด · RESERVA" };

export default function ScanPage() {
  requireUser();
  const lang = getLang();

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "scan.title")}
        </h1>
        <p className="text-sm text-slate-500">{t(lang, "scan.subtitle")}</p>
      </div>
      <ScannerClient lang={lang} />
    </div>
  );
}
