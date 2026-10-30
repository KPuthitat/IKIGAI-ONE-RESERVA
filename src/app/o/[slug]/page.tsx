import type { Metadata } from "next";
import { getDb } from "@/lib/db";
import { listMenu } from "@/lib/delivera/orders";
import { listOptionGroups } from "@/lib/delivera/options";
import GuestOrderClient, { type GuestMenuItem } from "./GuestOrderClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สั่งอาหาร · NOKHOOK OS" };

// Public ordering page opened from the table / counter QR (no login). /o/<branch-slug>?t=<table label>
export default function GuestOrderPage({ params, searchParams }: { params: { slug: string }; searchParams: { t?: string } }) {
  const branch = getDb().prepare("SELECT id, name, delivera_enabled FROM branches WHERE slug = ?").get(params.slug) as { id: number; name: string; delivera_enabled: number } | undefined;
  if (!branch || branch.delivera_enabled !== 1) {
    return <div className="mx-auto max-w-md px-4 py-16 text-center text-slate-600">ร้านนี้ยังไม่เปิดรับออเดอร์ออนไลน์ค่ะ</div>;
  }
  const menu = listMenu(branch.id, { availableOnly: true });
  const options = listOptionGroups(menu.map((m) => m.id));
  const items: GuestMenuItem[] = menu.map((m) => ({ id: m.id, name: m.name_th, description: m.description, price: m.price, image: m.image_url, category: m.category?.trim() || "เมนู", options: options.get(m.id) ?? [] }));
  const table = (searchParams.t ?? "").trim().slice(0, 20) || null;
  return <GuestOrderClient branch={{ id: branch.id, name: branch.name }} table={table} items={items} />;
}
