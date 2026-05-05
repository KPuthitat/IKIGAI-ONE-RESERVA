import LoginForm from "./LoginForm";

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="card w-full max-w-sm">
        <h1 className="text-xl font-semibold mb-1">เข้าระบบจัดการ</h1>
        <p className="text-sm text-slate-500 mb-4">IKIGAI ONE RESERVA</p>
        <LoginForm />
      </div>
    </main>
  );
}
