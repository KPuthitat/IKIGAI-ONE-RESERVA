import Link from "next/link";
import Mascot from "./components/Mascot";

// 404 — a page of its own, so Nong Plara can be big here without touching any existing layout.
export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-5">
      <div className="card w-full max-w-md text-center py-8">
        <Mascot pose="shock" size={160} className="mx-auto" />
        <h1 className="text-xl font-bold text-slate-800 mt-3">ไม่พบหน้านี้</h1>
        <p className="text-sm text-slate-500 mt-1">ลิงก์อาจผิด หรือหน้านี้ถูกย้ายไปแล้ว</p>
        <Link href="/" className="btn-primary mt-5 inline-flex">กลับหน้าหลัก</Link>
      </div>
    </div>
  );
}
