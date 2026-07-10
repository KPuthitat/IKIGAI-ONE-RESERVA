import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isDeliveraBranch, getBranchSettings, listZones } from "@/lib/delivera/db";
import { listMenu } from "@/lib/delivera/orders";
import SettingsClient from "./SettingsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ตั้งค่า / เมนู · DELIVERA" };

export default function DeliveraSettingsPage() {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return <div className="card text-sm text-slate-600">ยังไม่ได้เลือกสาขา</div>;
  const branchId = user.activeBranchId;
  const branch = getDb().prepare("SELECT name, latitude, longitude FROM branches WHERE id = ?").get(branchId) as { name: string; latitude: number | null; longitude: number | null } | undefined;
  const settings = getBranchSettings(branchId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">ตั้งค่า / เมนู · DELIVERA</h1>
          <p className="text-sm text-slate-500">สาขา <b>{branch?.name ?? `#${branchId}`}</b></p>
        </div>
        <Link href="/admin/delivera/kitchen" className="text-sm text-slate-500 hover:text-brand">← กระดานครัว</Link>
      </div>
      <SettingsClient
        enabled={isDeliveraBranch(branchId)}
        promptpayId={settings.promptpay_id}
        promptpayQrUrl={settings.promptpay_qr_url}
        codEnabled={settings.cod_enabled === 1}
        prepMinutes={settings.default_prep_minutes}
        hooks={{
          deduct_stock: settings.hook_deduct_stock === 1,
          post_income: settings.hook_post_income === 1,
          record_insigna: settings.hook_record_insigna === 1
        }}
        hasCoords={branch?.latitude != null && branch?.longitude != null}
        menu={listMenu(branchId).map((m) => ({ id: m.id, name_th: m.name_th, category: m.category, price: m.price, is_available: m.is_available === 1, image_url: m.image_url }))}
        zones={listZones(branchId).map((z) => ({ id: z.id, name: z.name, max_distance_km: z.max_distance_km, base_fee: z.base_fee, per_km_fee: z.per_km_fee, min_order_amount: z.min_order_amount }))}
      />
    </div>
  );
}
