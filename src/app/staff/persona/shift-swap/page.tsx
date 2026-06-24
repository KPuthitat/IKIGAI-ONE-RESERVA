import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { listIncomingSwaps, listMySentSwaps } from "@/lib/shift-swap";
import SwapClient from "./SwapClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สลับกะ · IKIGAI OS" };

// Staff self-service: A asks B to swap their shift on the same day. B taps
// accept and the roster swaps automatically — no admin approval.
export default function ShiftSwapPage() {
  const user = requireUser();
  return <SwapClient incoming={listIncomingSwaps(user.id)} sent={listMySentSwaps(user.id)} />;
}
