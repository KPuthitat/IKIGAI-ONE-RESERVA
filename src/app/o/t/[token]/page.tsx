import type { Metadata } from "next";
import TrackerClient from "./TrackerClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ติดตามออเดอร์ · NOKHOOK OS" };

export default function TrackerPage({ params }: { params: { token: string } }) {
  return <TrackerClient token={params.token} />;
}
