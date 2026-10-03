// /admin/insigna/members/qr — printable membership QR, one per branch.
//
// The QR opens the branch's LINE OA with a prefilled "สมาชิก" message. When the
// customer sends it, the webhook pushes the sign-up card (or the member card
// for an existing member). Branches without an @-form OA URL show a hint.

import type { Metadata } from "next";
import Link from "next/link";
import QRCode from "qrcode";
import { requireAdmin } from "@/lib/auth";
import { listBranchReviewInfo } from "@/lib/insigna";
import { oaKeywordDeepLink, MEMBER_QR_KEYWORD } from "@/lib/line";
import PrintButton from "../../reviews/qr/PrintButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "QR สมัครสมาชิก · INSIGNA" };

export default async function MemberQrPage() {
  requireAdmin();
  const branches = listBranchReviewInfo();
  const cards = await Promise.all(branches.map(async (b) => {
    const url = oaKeywordDeepLink(b.customer_line_oa_url, MEMBER_QR_KEYWORD);
    const png = url ? await QRCode.toDataURL(url, { width: 640, margin: 2, errorCorrectionLevel: "M" }) : null;
    return { ...b, url, png };
  }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap print:hidden">
        <div>
          <Link href="/admin/insigna" className="text-xs text-slate-400 hover:text-brand">← INSIGNA</Link>
          <h1 className="text-2xl font-bold text-slate-800 mt-1">QR สมัครสมาชิก</h1>
          <p className="text-sm text-slate-500 mt-1">
            ลูกค้าสแกน → เข้า LINE OA ของสาขา → กดส่งคำว่า “สมาชิก” → ระบบส่งการ์ดสมัครสมาชิก (หรือบัตรสมาชิกถ้าเป็นสมาชิกแล้ว) ในแชท · พิมพ์ทั้งหน้าเพื่อติดที่เคาน์เตอร์
          </p>
        </div>
        <PrintButton />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {cards.map((c) => (
          <div key={c.branch_id} className="rounded-2xl border border-slate-200 bg-white p-6 text-center break-inside-avoid">
            <div className="text-[11px] font-bold uppercase tracking-widest text-brand">IKIGAI · สมาชิก</div>
            <div className="text-lg font-bold text-slate-800 mt-1">{c.branch_name}</div>
            {c.png ? (
              <>
                <div className="text-sm text-slate-500 mt-3">สแกนเพื่อสมัครสมาชิกผ่าน LINE</div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.png} alt={`QR สมาชิก ${c.branch_name}`} width={220} height={220} className="mx-auto my-3 w-[220px] h-[220px]" />
                <div className="text-[11px] text-slate-400">สมัครฟรี · เก็บเพียงวันเกิดและเพศ · ไม่เก็บชื่อ</div>
                <div className="text-[11px] text-slate-400 break-all mt-1">{c.url}</div>
              </>
            ) : (
              <div className="text-sm text-amber-700 mt-3">
                ยังไม่มีลิงก์ LINE OA แบบ @ ของสาขานี้ — ตั้งค่า “ลิงก์เพิ่มเพื่อน LINE OA” ของสาขาในรูปแบบ https://line.me/R/ti/p/@xxxx ก่อน
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
