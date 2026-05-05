"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

export default function LoginForm() {
  const router = useRouter();
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    const res = await fetch(apiUrl("/api/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p })
    });
    setLoading(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error || "เข้าระบบไม่สำเร็จ");
      return;
    }
    router.push("/admin");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="label">ชื่อผู้ใช้</label>
        <input className="input" required value={u} onChange={(e) => setU(e.target.value)} />
      </div>
      <div>
        <label className="label">รหัสผ่าน</label>
        <input className="input" required type="password" value={p} onChange={(e) => setP(e.target.value)} />
      </div>
      {err && <div className="text-red-600 text-sm">{err}</div>}
      <button className="btn-primary w-full" disabled={loading}>
        {loading ? "กำลังเข้าระบบ..." : "เข้าระบบ"}
      </button>
    </form>
  );
}
