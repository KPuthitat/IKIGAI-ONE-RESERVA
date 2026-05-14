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
          <OwlMascot size={96} mood="wink" />
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-slate-800">
              ห้องน้องฮูก
            </h1>
            <p className="text-base text-amber-900 font-bold mt-1">
              สวัสดีครับพี่ๆ น้องฮูกอยู่นี่แล้ว
            </p>
            <p className="text-sm text-slate-700 mt-1 leading-relaxed">
              พี่ๆ มีอะไรงงๆ ไม่เข้าใจ ลองพิมพ์คำถาม หรือกดดูตามหมวดด้านล่างได้เลยนะครับ
              น้องเตรียมคำตอบไว้ให้แล้ว ถ้ายังไม่เจอที่ต้องการ บอกพี่แอดมินได้นะครับ
              น้องจะค่อยๆ จำเพิ่มขึ้นเรื่อยๆ
            </p>
            <p className="text-[11px] text-amber-700 mt-2">
              ตอนนี้น้องรู้ {FAQ_ENTRIES.length} คำถาม · จัดไว้ {FAQ_CATEGORIES.length} หมวด
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
