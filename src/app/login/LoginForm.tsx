"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type Role = "admin" | "staff";

export default function LoginForm({
  next,
  error: initialError
}: { next?: string; error?: string }) {
  const router = useRouter();
  const [role, setRole] = useState<Role>("staff");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(initialError ?? null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error || "เข้าระบบไม่สำเร็จ");
        return;
      }
      // ถ้ามี ?next= ให้ไปที่นั้น (ใช้กับ Nginx auth_request redirect)
      const dest = next || (data.role === "admin" ? "/admin" : "/staff");
      router.push(dest);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* role selector — แยก 2 ปุ่มชัดเจน ไม่อยู่ในกรอบเดียว */}
      <div className="flex gap-3 mb-5 w-full max-w-sm">
        <button
          type="button"
          onClick={() => setRole("staff")}
          className={`flex-1 py-3.5 rounded-xl text-base font-bold tracking-[1.5px] transition-all ${
            role === "staff"
              ? "bg-brand text-white shadow-[0_4px_16px_rgba(233,69,96,.4)]"
              : "bg-white/10 text-white/60 hover:bg-white/15"
          }`}
        >STAFF</button>
        <button
          type="button"
          onClick={() => setRole("admin")}
          className={`flex-1 py-3.5 rounded-xl text-base font-bold tracking-[1.5px] transition-all ${
            role === "admin"
              ? "bg-brand text-white shadow-[0_4px_16px_rgba(233,69,96,.4)]"
              : "bg-white/10 text-white/60 hover:bg-white/15"
          }`}
        >ADMIN</button>
      </div>

      {/* role label — ตัวใหญ่ ไม่อยู่ในกรอบ */}
      <div className="text-white text-xl font-bold mb-5 text-center">
        สำหรับ{role === "admin" ? "ผู้ดูแลระบบ" : "พนักงาน"}
      </div>

      <form onSubmit={submit} className="card w-full max-w-sm">

        <div className="mb-4">
          <label className="label">ชื่อผู้ใช้</label>
          <input
            className="input" required autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>

        <div className="mb-4">
          <label className="label">รหัสผ่าน</label>
          <input
            type="password" className="input" required autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {err && (
          <div className="text-red-600 text-sm text-center min-h-[18px] mb-2">{err}</div>
        )}

        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "กำลังเข้าระบบ..." : "เข้าระบบ"}
        </button>
      </form>
    </>
  );
}
