import type { Metadata } from "next";
import RiderClient from "./RiderClient";

// IKIGAI RIDER LIFF entry — separate LINE channel from customer + staff. The
// rider opens a per-branch link (?branch=<id>) to register to that shop.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "IKIGAI RIDER" };

export default function DeliveraRiderPage({ searchParams }: { searchParams: { branch?: string } }) {
  const liffId = process.env.NEXT_PUBLIC_LINE_RIDER_LIFF_ID ?? "";
  const branchId = Number(searchParams.branch) || 0;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <script src="https://static.line-scdn.net/liff/edge/2/sdk.js" async />
      <RiderClient liffId={liffId} branchId={branchId} />
    </>
  );
}
