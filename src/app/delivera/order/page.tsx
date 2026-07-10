import type { Metadata } from "next";
import OrderClient from "./OrderClient";

// Customer LIFF entry — loads the LINE LIFF SDK, then the ordering client picks
// up window.liff. Mirrors the staff portal LIFF scaffold.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "DELIVERA · สั่งอาหาร" };

export default function DeliveraOrderPage() {
  const liffId = process.env.NEXT_PUBLIC_LINE_CUSTOMER_LIFF_ID ?? "";
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <script src="https://static.line-scdn.net/liff/edge/2/sdk.js" async />
      <OrderClient liffId={liffId} />
    </>
  );
}
