import type { Metadata } from "next";
import LoginForm from "./LoginForm";
import LangToggle from "../LangToggle";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เข้าระบบ" };

export default function LoginPage({
  searchParams
}: { searchParams: { next?: string; error?: string } }) {
  return (
    <main className="min-h-screen bg-ink-gradient flex flex-col items-center p-6 pt-[18vh]">
      <div className="text-center mb-10">
        <div className="brand-wordmark text-white text-[42px]">IKIGAI OS</div>
      </div>

      <LoginForm next={searchParams.next} error={searchParams.error} />

      <div className="mt-8">
        <LangToggle variant="dark" />
      </div>
    </main>
  );
}
