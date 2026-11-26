import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { viewerOf } from "@/lib/purchasing";
import MemosClient from "./MemosClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Memo ขอซื้อ · ลงนาม" };

// Memo → ลงลายมือชื่อ → เปิด PR (owner 2026-11-26). Admins and executives only.
export default function MemosPage({ searchParams }: { searchParams: { id?: string } }) {
  const user = requireUser();
  const v = viewerOf(user);
  if (user.role === "staff" && !v.isCLevel) redirect("/admin");
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Memo ขอซื้อ · ลงลายมือชื่อ</h1>
        <p className="text-sm text-slate-500">ทุกการซื้อเริ่มจาก Memo: เลือกผู้ที่เกี่ยวข้อง ทุกคนลงลายมือชื่อครบ จึงเปิด PR ได้ แล้วผู้บริหารอนุมัติ PR → เปิด PO → ซื้อได้</p>
      </div>
      <MemosClient openId={searchParams.id ? Number(searchParams.id) || null : null} />
    </div>
  );
}
