import type { Metadata } from "next";
import Link from "next/link";
import OwlMascot from "../components/OwlMascot";
import HelpClient from "./HelpClient";
import { FAQ_CATEGORIES, FAQ_ENTRIES } from "@/lib/owl-faq";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ห้องน้องฮูก · IKIGAI OS" };

// /help — the full-page version of น้องฮูก's FAQ. Accessible to all
// users (including logged-out) so anyone can browse the manual.
// Categories are tabs along the top; the matching entries below
// list expandable accordion items. Search-box at the top filters
// live across every category.

export default function HelpPage() {
  return (
    <div className="min-h-screen bg-amber-50/40">
      <header className="bg-amber-100 border-b border-amber-200">
        <div className="max-w-3xl mx-auto px-4 py-6 flex items-center gap-4">
          <OwlMascot size={88} mood="wink" />
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-slate-800">ห้องน้องฮูก</h1>
            <p className="text-sm text-slate-600 mt-0.5">
              ผมคือน้องฮูก คอยตอบคำถามเรื่องการใช้งาน IKIGAI OS — ลองพิมพ์คำถามหรือเลือกหมวดด้านล่างได้เลยครับ
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              มีคำถามทั้งหมด {FAQ_ENTRIES.length} ข้อ · {FAQ_CATEGORIES.length} หมวด
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6">
        <HelpClient />
        <div className="mt-8 text-center text-xs text-slate-500">
          <Link href="/" className="text-brand hover:underline">← กลับหน้าหลัก</Link>
        </div>
      </main>
    </div>
  );
}
