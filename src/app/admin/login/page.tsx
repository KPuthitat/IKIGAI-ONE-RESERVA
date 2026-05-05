import LoginForm from "./LoginForm";

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-ink-gradient flex flex-col items-center justify-center p-6">
      <div className="text-center mb-7">
        <div className="brand-wordmark text-white text-[42px]">IKIGAI ONE</div>
        <div className="text-white/50 text-[13px] tracking-[1px] mt-1">RESERVA</div>
        <div className="inline-block mt-2.5 px-3.5 py-1 rounded-full text-[11px] tracking-[1px] bg-white/15 text-white/70">
          ระบบจองโต๊ะ
        </div>
      </div>

      <div className="card w-full max-w-sm">
        <h1 className="text-lg font-bold mb-5 text-slate-800">เข้าระบบจัดการ</h1>
        <LoginForm />
      </div>
    </main>
  );
}
