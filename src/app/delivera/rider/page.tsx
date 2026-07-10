import type { Metadata } from "next";
import { riderCreds } from "@/lib/delivera/channels";
import RiderClient from "./RiderClient";

// IKIGAI RIDER LIFF entry — separate LINE channel from customer + staff. The
// rider opens a per-branch link (?branch=<id>) to register to that shop.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ทีมงานส่งสุข" };

export default function DeliveraRiderPage({ searchParams }: { searchParams: { branch?: string } }) {
  const liffId = riderCreds().liffId ?? "";
  const branchId = Number(searchParams.branch) || 0;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <script src="https://static.line-scdn.net/liff/edge/2/sdk.js" async />
      <RiderClient liffId={liffId} branchId={branchId} />
    </>
  );
}
