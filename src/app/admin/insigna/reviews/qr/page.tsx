// /admin/insigna/reviews/qr — printable QR posters, one per branch.
//
// Owner 2026-09-24: the QR now routes the customer INTO the branch's LINE OA
// (a prefilled "รีวิว" message). When they send it, the webhook pushes the
// rating card and — after they rate — the reward code lands in their own OA
// chat, so nothing is lost when they close a browser tab. Branches without a
// configured OA URL fall back to the plain web form (anonymous, no LINE tie).
// Print the page (A4) for a sheet of table cards, or download one PNG.

import type { Metadata } from "next";
import Link from "next/link";
import QRCode from "qrcode";
import { requireAdmin } from "@/lib/auth";
import { listBranchReviewInfo, getReviewConfig } from "@/lib/insigna";
import { oaReviewDeepLink } from "@/lib/line";
import PrintButton from "./PrintButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "QR รีวิว · INSIGNA" };

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/+$/, "");

export default async function ReviewQrPage() {
  requireAdmin();
  const cfg = getReviewConfig();
  const branches = listBranchReviewInfo();

  const cards = await Promise.all(
    branches.map(async (b) => {
      const deepLink = oaReviewDeepLink(b.customer_line_oa_url);
      const url = deepLink ?? `${PUBLIC_BASE}/f/${b.branch_slug}`;
      const mode: "line" | "web" = deepLink ? "line" : "web";
      const png = await QRCode.toDataURL(url, { width: 640, margin: 2, errorCorrectionLevel: "M" });
      return { ...b, url, png, mode };
    })
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap print:hidden">
        <div>
          <Link href="/admin/insigna/reviews" className="text-xs text-slate-400 hover:text-brand">← รีวิวลูกค้า</Link>
          <h1 className="text-2xl font-bold text-slate-800 mt-1">QR สำหรับติดที่โต๊ะ</h1>
          <p className="text-sm text-slate-500 mt-1">
            ลูกค้าสแกน → เข้า LINE OA ของสาขา → กดส่งคำว่า “รีวิว” → ระบบส่งการ์ดให้คะแนนในแชท
            (โค้ดแลกส่วนลดถูกเก็บในไลน์ของลูกค้าเอง) · ดาวน์โหลดรูป หรือกดพิมพ์ทั้งหน้า
          </p>
        </div>
        <PrintButton />
      </div>

      {!cfg.enabled && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 print:hidden">
          ระบบรีวิวยังปิดอยู่ — QR สแกนได้แต่ระบบจะยังไม่ส่งการ์ดให้คะแนน จนกว่าจะเปิดใน
          <Link href="/admin/insigna/reviews" className="underline ml-1">ตั้งค่าระบบรีวิว</Link>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {cards.map((c) => (
          <div key={c.branch_id} className="rounded-2xl border border-slate-200 bg-white p-6 text-center break-inside-avoid">
            <div className="text-[11px] font-bold uppercase tracking-widest text-brand">IKIGAI · รีวิวร้าน</div>
            <div className="text-lg font-bold text-slate-800 mt-1">{c.branch_name}</div>
            <div className="text-sm text-slate-500 mt-3">
              {c.mode === "line" ? "สแกนเพื่อรีวิวผ่าน LINE" : "สแกนเพื่อให้คะแนนร้าน"}
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.png} alt={`QR ${c.branch_name}`} width={220} height={220}
              className="mx-auto my-3 w-[220px] h-[220px]" />
            <div className="text-[11px] text-slate-400 break-all">{c.url}</div>
            {c.mode === "web" && (
              <div className="mt-2 rounded-md bg-amber-50 border border-amber-200 px-2 py-1.5 text-[11px] text-amber-700 print:hidden">
                สาขานี้ยังไม่ได้ตั้งค่า LINE OA URL — QR จะเปิดหน้าเว็บ (ไม่ผูกไลน์/ไม่เก็บโค้ดในแชท)
                ตั้งค่าลิงก์ OA ที่หน้า ตั้งค่าสาขา ก่อนพิมพ์ค่ะ
              </div>
            )}
            <a
              href={c.png}
              download={`qr-review-${c.branch_slug}.png`}
              className="inline-block mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white print:hidden"
            >
              ดาวน์โหลด PNG
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
