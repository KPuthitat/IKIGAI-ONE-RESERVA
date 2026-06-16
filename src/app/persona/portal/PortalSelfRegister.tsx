"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";

// New-employee self-registration form, shown on the PORTAL not_bound screen
// (owner 2026-06-16). The employee proves identity with national_id + dob
// (both on their hire record) and sets their own username/password. The LINE
// userId is captured server-side from the LIFF accessToken — getAccessToken()
// is supplied by the parent (PortalClient) which already has LIFF initialised.
export default function PortalSelfRegister({
  getAccessToken,
  onDone
}: {
  getAccessToken: () => string | null;
  onDone: () => void;
}) {
  const [natId, setNatId] = useState("");
  const [dob, setDob] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (natId.replace(/\D/g, "").length < 8) { setErr("เลขบัตรประชาชนไม่ถูกต้อง"); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) { setErr("กรุณาเลือกวันเกิด"); return; }
    if (username.trim().length < 3) { setErr("ชื่อผู้ใช้อย่างน้อย 3 ตัวอักษร"); return; }
    if (password.length < 6) { setErr("รหัสผ่านอย่างน้อย 6 ตัวอักษร"); return; }
    if (pin && !/^\d{4}$/.test(pin)) { setErr("PIN ต้องเป็นตัวเลข 4 หลัก"); return; }

    const accessToken = getAccessToken();
    if (!accessToken) {
      setErr("ดึงข้อมูล LINE ไม่ได้ — กรุณาเปิดหน้านี้ผ่านแอป LINE");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/persona/self-register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken,
          national_id: natId,
          dob,
          username: username.trim(),
          password,
          ...(pin ? { pin } : {})
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        const map: Record<string, string> = {
          no_match: "ไม่พบข้อมูลพนักงาน — ตรวจสอบเลขบัตรประชาชน + วันเกิด ให้ตรงกับที่แจ้งไว้ หรือติดต่อแอดมิน",
          username_taken: "ชื่อผู้ใช้นี้มีคนใช้แล้ว ลองอันอื่นครับ",
          line_already_registered: "บัญชี LINE นี้ลงทะเบียนไว้แล้ว — กดเข้าระบบได้เลย",
          invalid_line_token: "เซสชัน LINE หมดอายุ — ปิดหน้านี้แล้วเปิดใหม่ในแอป LINE",
          already_claimed: "บัญชีนี้เพิ่งถูกลงทะเบียนไปแล้ว",
          invalid_national_id: "เลขบัตรประชาชนไม่ถูกต้อง"
        };
        setErr(map[j.error as string] ?? "ลงทะเบียนไม่สำเร็จ ลองอีกครั้ง");
        return;
      }
      onDone();
    } catch {
      setErr("เกิดข้อผิดพลาดในการเชื่อมต่อ ลองอีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2.5 text-left pt-1">
      <p className="text-xs text-slate-500 text-center">
        ยืนยันตัวตนด้วยเลขบัตรประชาชน + วันเกิด (ตามที่แจ้งไว้ตอนสมัคร) แล้วตั้งบัญชีของคุณ
      </p>
      <div>
        <label className="label">เลขบัตรประชาชน</label>
        <input
          className="input text-sm"
          inputMode="numeric"
          value={natId}
          onChange={(e) => setNatId(e.target.value)}
          placeholder="13 หลัก"
          maxLength={20} />
      </div>
      <div>
        <label className="label">วันเกิด</label>
        <input
          className="input text-sm"
          type="date"
          value={dob}
          onChange={(e) => setDob(e.target.value)} />
      </div>
      <div>
        <label className="label">ตั้งชื่อผู้ใช้ (username)</label>
        <input
          className="input text-sm"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="เช่น somchai.k"
          maxLength={40} />
      </div>
      <div>
        <label className="label">ตั้งรหัสผ่าน</label>
        <input
          className="input text-sm"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="อย่างน้อย 6 ตัวอักษร"
          maxLength={100} />
      </div>
      <div>
        <label className="label">PIN 4 หลัก (สำหรับลงเวลา — ไม่บังคับ)</label>
        <input
          className="input text-sm"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="ตั้งทีหลังได้"
          maxLength={4} />
      </div>

      {err && <p className="text-xs text-rose-600 text-center">{err}</p>}

      <button
        type="submit"
        disabled={busy}
        className="block w-full py-2.5 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50"
      >
        {busy ? "กำลังลงทะเบียน…" : "ลงทะเบียน + เข้าระบบ"}
      </button>
    </form>
  );
}
