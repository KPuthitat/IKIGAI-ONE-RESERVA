import type { Metadata } from "next";
import TrackClient from "./TrackClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "DELIVERA · ติดตามออเดอร์" };

export default function DeliveraTrackPage({ params }: { params: { orderNo: string } }) {
  const liffId = process.env.NEXT_PUBLIC_LINE_CUSTOMER_LIFF_ID ?? "";
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <script src="https://static.line-scdn.net/liff/edge/2/sdk.js" async />
      <TrackClient liffId={liffId} orderNo={params.orderNo} />
    </>
  );
}
