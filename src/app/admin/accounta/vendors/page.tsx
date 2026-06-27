import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listVendorsManage } from "@/lib/accounta-db";
import VendorsClient from "./VendorsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · ผู้จำหน่าย / คู่ค้า" };

// Manage the branch's vendor/supplier master from ACCOUNTA (owner 2026-06-27).
// Same list shared with INVENTA (inventa_suppliers), branch-scoped.
export default function AccountaVendorsPage() {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  const branch = branchId != null
    ? (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined)
    : undefined;

  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ผู้จำหน่าย / คู่ค้า</h1>
        <p className="text-sm text-slate-500 mt-1">
          สาขา <b>{branch?.name ?? `#${branchId}`}</b> · รายชื่อเดียวกับ INVENTA — เพิ่ม/แก้ชื่อ เลขผู้เสียภาษี หมวดเริ่มต้น
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          เลขผู้เสียภาษีช่วยให้ OCR จับคู่คู่ค้าได้แม่นขึ้น · รายการ “รอตรวจ” คือคู่ค้าที่ระบบสร้างอัตโนมัติจากบิลที่สแกน
        </p>
      </div>
      <VendorsClient initialVendors={listVendorsManage(branchId)} />
    </div>
  );
}
