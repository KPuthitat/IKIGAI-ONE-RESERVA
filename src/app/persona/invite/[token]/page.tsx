import type { Metadata } from "next";
import { lookupValidInvite } from "@/lib/invites";
import OwlMascot from "../../../components/OwlMascot";
import RedeemForm from "./RedeemForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เชิญเข้าใช้งาน · IKIGAI OS" };

// /persona/invite/[token] — public-facing landing page that the staff
// opens from the LINE link the admin sent them. Lives under /persona/
// because staff onboarding belongs to the PERSONA module (RESERVA is
// for customer bookings).
//
// We look up the invite server-side first so an expired/used token
// shows a friendly error without leaking the form. On success, the
// RedeemForm collects the staff's username + password + PIN and POSTs
// them to /api/persona/invite/[token], which then auto-creates a
// session and routes the staff to /staff/persona.

export default function InviteRedeemPage({ params }: { params: { token: string } }) {
  const invite = lookupValidInvite(params.token);

  if (!invite) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-amber-50/40 p-4">
        <div className="card max-w-md w-full text-center space-y-3">
          <OwlMascot size={140} mood="thinking" className="mx-auto block" />
          <h1 className="text-xl font-bold text-slate-800">ลิงก์เชิญใช้งานไม่ถูกต้อง</h1>
          <p className="text-sm text-slate-600">
            ลิงก์นี้อาจหมดอายุ หรือถูกใช้ไปแล้ว
            <br />
            กรุณาขอลิงก์ใหม่จากหัวหน้างานครับ
          </p>
        </div>
      </div>
    );
  }

  const kindCopy = invite.kind === "onboard"
    ? { title: "ยินดีต้อนรับเข้าทีมครับ!", sub: "สร้างบัญชีของคุณก่อนเริ่มใช้งาน" }
    : invite.kind === "reset"
      ? { title: "ตั้งรหัสผ่านใหม่", sub: "ตั้ง username + password + PIN ใหม่เพื่อใช้ล็อกอินครั้งต่อไป" }
      : { title: "ผูก LINE ใหม่", sub: "ระบบจะผูก LINE ใหม่ของคุณกับบัญชีเดิม" };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-amber-50/40 p-4">
      <div className="card max-w-md w-full space-y-4">
        <div className="text-center">
          <OwlMascot size={140} mood="smile" className="mx-auto block" />
          <h1 className="text-2xl font-bold text-slate-800 mt-2">{kindCopy.title}</h1>
          <p className="text-sm text-amber-700 mt-1">{kindCopy.sub}</p>
          <p className="text-base font-bold text-slate-700 mt-3">
            สวัสดี <span className="text-brand">{invite.user_display_name}</span> ครับ
          </p>
        </div>
        <RedeemForm
          token={params.token}
          kind={invite.kind}
          displayName={invite.user_display_name}
        />
      </div>
    </div>
  );
}
