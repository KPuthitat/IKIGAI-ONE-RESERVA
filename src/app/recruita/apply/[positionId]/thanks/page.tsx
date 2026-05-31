import type { Metadata } from "next";
import Link from "next/link";
import OwlMascot from "@/app/components/OwlMascot";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ส่งใบสมัครเรียบร้อย · IKIGAI Recruit" };

// /recruita/apply/[positionId]/thanks — success landing after the
// applicant submits. Mirrors the LIFF "เข้าระบบสำเร็จ" pattern
// the owner already validated visually.

export default function ApplyThanksPage(
  { searchParams }: { searchParams: { aid?: string } }
) {
  return (
    <div className="min-h-screen bg-amber-50/40 flex items-center justify-center p-4">
      <main className="card max-w-md w-full text-center space-y-3">
        <OwlMascot size={140} mood="smile"
          ariaLabel="ส่งใบสมัครสำเร็จ"
          className="mx-auto block" />
        <h1 className="text-xl font-bold text-slate-800">
          ส่งใบสมัครเรียบร้อย 🎉
        </h1>
        {searchParams.aid && (
          <p className="text-xs text-slate-400 font-mono">
            เลขที่ใบสมัคร #{searchParams.aid}
          </p>
        )}
        <div className="text-sm text-slate-600 leading-relaxed">
          ขอบคุณที่ให้ความสนใจร่วมงานกับกลุ่มบริษัท อิคิไก ฟอร์ออล<br />
          หากได้รับคัดเลือกให้เข้าสัมภาษณ์ ทีมงานจะติดต่อกลับผ่านเบอร์ที่คุณให้ไว้<br />
          <span className="text-emerald-700 font-bold">หวังว่าจะได้พบกันเร็วๆ นี้ค่ะ 🦉</span>
        </div>
        <div className="border-t border-slate-100 pt-3 mt-3 space-y-2">
          <Link href="/recruita/positions"
            className="block text-sm text-brand hover:underline">
            ← ดูตำแหน่งอื่นที่เปิดรับ
          </Link>
        </div>
      </main>
    </div>
  );
}
