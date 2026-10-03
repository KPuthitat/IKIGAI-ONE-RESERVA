// /m/s/<scan token> — what the member-card QR encodes. Staff scan it with the
// in-app scanner (which only parses the token); if a person opens the URL in
// a browser, show a neutral page that reveals nothing about the member.

import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "QR สมาชิก · IKIGAI", robots: { index: false, follow: false } };

export default function MemberScanLanding() {
  return (
    <div className="min-h-screen bg-slate-100 flex items-start justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow border border-slate-200 p-8 text-center mt-10">
        <div className="text-4xl mb-3">🌿</div>
        <div className="text-slate-700 font-semibold">QR นี้สำหรับให้พนักงานสแกน</div>
        <div className="text-sm text-slate-400 mt-1">แสดงบัตรสมาชิกในแชท LINE ของร้านตอนชำระเงินค่ะ</div>
      </div>
    </div>
  );
}
