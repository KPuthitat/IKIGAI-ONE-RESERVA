import type { Metadata } from "next";
import LoginForm from "./LoginForm";
import LangToggle from "../LangToggle";
import Footer from "../Footer";
import OwlMascot from "../components/OwlMascot";
import { lineLoginConfigured } from "@/lib/line-login";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เข้าระบบ" };

// Map the ?error= codes the LINE-login routes bounce back with into a
// friendly Thai line. Password-login errors arrive via the API response
// instead, so anything not listed here is passed through untouched.
const ERROR_MESSAGES: Record<string, string> = {
  line_not_linked: "LINE นี้ยังไม่ได้ผูกกับบัญชีพนักงาน กรุณาเข้าด้วยรหัสผ่าน หรือติดต่อแอดมินให้ผูก LINE ให้ก่อน",
  line_unavailable: "ยังเปิดใช้เข้าระบบด้วย LINE ไม่ได้ กรุณาเข้าด้วยรหัสผ่าน",
  line_state: "หมดเวลาการเข้าระบบด้วย LINE กรุณาลองใหม่อีกครั้ง",
  line_exchange: "เชื่อมต่อ LINE ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
  account_resigned: "บัญชีนี้ถูกปิดเนื่องจากครบกำหนดวันลาออกแล้ว กรุณาติดต่อแอดมิน",
  account_disabled: "บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อแอดมิน",
  account_pending_invite: "บัญชียังไม่ได้ตั้งค่าครั้งแรก กรุณากดลิงก์เชิญที่แอดมินส่งให้ก่อน"
};

// Login page (2026-05-31 v3 — minimal owl + brand only).
//
// Owner direction: keep the original LoginForm behaviour intact,
// just change the surrounding chrome. Final form:
//   • bg-amber-50/40 base (matches /persona/portal)
//   • Centered white card: static owl 140 → IKIGAI OS wordmark →
//     username/password form → submit
//   • LangToggle outside the card (subtler)
//   • Footer at page bottom
// No floating animation, no tagline, no welcome line. The STAFF/ADMIN
// picker was removed 2026-06-03 — login is unified; the session role
// decides access and admins flip to the console from the sidebar. The
// form inherits LINE Seed Sans TH via the global body font rule.

export default function LoginPage({
  searchParams
}: { searchParams: { next?: string; error?: string } }) {
  return (
    <div className="min-h-screen flex flex-col bg-amber-50/40">
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-8">
        <div className="card max-w-md w-full text-center space-y-3 pt-10">
          {/* Static owl — extra top padding (pt-10) gives น้องฮูก more
              headroom above the card edge (owner 2026-06-03). */}
          <OwlMascot
            size={140}
            mood="smile"
            ariaLabel="IKIGAI OS PORTAL"
            className="mx-auto block"
          />
          {/* Program wordmark removed per owner 2026-06-06 — the owl
              alone heads the login card. */}

          {/* Form lives inside the same card — keeps the visual
              footprint single instead of stacking "title card" +
              "form card" which read as two separate ideas. */}
          <div className="pt-3 text-left">
            <LoginForm
              next={searchParams.next}
              error={searchParams.error ? (ERROR_MESSAGES[searchParams.error] ?? searchParams.error) : undefined}
              lineLoginEnabled={lineLoginConfigured()}
            />
          </div>
        </div>

        <div className="mt-6 flex items-center gap-4">
          <LangToggle variant="light" />
        </div>
      </main>

      <Footer />
    </div>
  );
}
