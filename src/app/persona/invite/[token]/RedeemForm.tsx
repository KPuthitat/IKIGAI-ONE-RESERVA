"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

const STORAGE_KEY_USER_ID = "invite_line_user_id";
const STORAGE_KEY_NAME = "invite_line_name";

// Invite redemption client.
//
// For "onboard" + "reset" — staff types a username + password + PIN.
// For "rebind_line" — credentials already exist, we only need a PIN
// to confirm the rebind belongs to the right person (defence against
// a stolen LINE-link being redeemed by a stranger).
//
// On success, the server auto-creates a session cookie, so a hard
// redirect to /staff/persona puts the staff straight into the app
// without a second login step.

type Kind = "onboard" | "reset" | "rebind_line";

export default function RedeemForm({
  token, kind, displayName
}: {
  token: string;
  kind: Kind;
  displayName: string;
}) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Captured from sessionStorage when the user came through
  // /persona/invite (the LIFF bridge). Empty if the user opened the
  // /persona/invite/<token> URL directly in a regular browser — in
  // that case admin will need to bind line_user_id later. The captured
  // displayName is shown as a "✓ เชื่อม LINE ของ <name> แล้ว"
  // banner so the staff knows their LINE got linked automatically.
  const [lineUserId, setLineUserId] = useState<string>("");
  const [lineName, setLineName] = useState<string>("");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const uid = sessionStorage.getItem(STORAGE_KEY_USER_ID) ?? "";
    const name = sessionStorage.getItem(STORAGE_KEY_NAME) ?? "";
    if (uid) setLineUserId(uid);
    if (name) setLineName(name);
  }, []);

  const isRebind = kind === "rebind_line";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    if (!isRebind) {
      if (username.length < 3) {
        setErr("กรุณาตั้งชื่อผู้ใช้อย่างน้อย 3 ตัวอักษร");
        return;
      }
      if (password.length < 6) {
        setErr("รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร");
        return;
      }
      if (password !== password2) {
        setErr("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
        return;
      }
    }
    if (!/^\d{4}$/.test(pin)) {
      setErr("PIN ต้องเป็นตัวเลข 4 หลัก");
      return;
    }
    if (pin !== pin2) {
      setErr("PIN ทั้งสองช่องไม่ตรงกัน");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/persona/invite/${token}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: isRebind ? "_rebind_only" : username,
          password: isRebind ? "_rebind_only_______" : password,
          pin,
          // Pass the LIFF-captured userId so the server can bind it
          // to the user row in the same atomic transaction. Empty
          // string when the user opened the page outside LINE.
          line_user_id: lineUserId || undefined
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        if (j.error === "username_taken") setErr("ชื่อผู้ใช้นี้มีคนใช้แล้ว ลองอันอื่นครับ");
        else if (j.error === "invalid_or_expired") setErr("ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่");
        else setErr(j.error ?? "เกิดข้อผิดพลาด ลองอีกครั้ง");
        return;
      }
      router.push("/staff/persona");
    } catch {
      setErr("เกิดข้อผิดพลาดในการเชื่อมต่อ ลองอีกครั้งครับ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {lineUserId && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800">
          ✓ เชื่อม LINE
          {lineName ? <> ของ <span className="font-bold">{lineName}</span></> : null}
          {" "}เรียบร้อย — หลังเริ่มใช้งานจะรับข้อความแจ้งเตือนได้ทันที
        </div>
      )}
      {!lineUserId && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-800">
          ⓘ ไม่ได้เปิดผ่าน LINE — admin จะต้องเชื่อมต่อ LINE ของคุณภายหลัง
          ถ้าต้องการรับแจ้งเตือน กรุณาปิดหน้านี้แล้วเปิดลิงก์ใหม่ใน LINE app
        </div>
      )}
      {!isRebind && (
        <>
          <div>
            <label className="label">ชื่อผู้ใช้ (Username)</label>
            <input
              type="text"
              className="input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="เช่น milk_thiti"
              maxLength={40}
            />
            <p className="text-[10px] text-slate-500 mt-1">
              ใช้ตัวอักษร/ตัวเลข/จุด/ขีดล่าง/ขีดกลาง · 3-40 ตัวอักษร
            </p>
          </div>
          <div>
            <label className="label">รหัสผ่าน (Password)</label>
            <input
              type="password"
              className="input"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="อย่างน้อย 6 ตัวอักษร"
              minLength={6}
            />
          </div>
          <div>
            <label className="label">ยืนยันรหัสผ่าน</label>
            <input
              type="password"
              className="input"
              autoComplete="new-password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              minLength={6}
            />
          </div>
        </>
      )}

      <div>
        <label className="label">PIN 4 หลัก (ใช้ลงเวลา/รับทราบหนังสือเตือน)</label>
        <input
          type="password"
          inputMode="numeric"
          maxLength={4}
          className="input tracking-widest text-center text-lg"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="••••"
        />
      </div>
      <div>
        <label className="label">ยืนยัน PIN</label>
        <input
          type="password"
          inputMode="numeric"
          maxLength={4}
          className="input tracking-widest text-center text-lg"
          value={pin2}
          onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="••••"
        />
      </div>

      {err && (
        <div className="text-sm text-rose-600 text-center">✗ {err}</div>
      )}

      <button type="submit" disabled={busy}
        className="btn-primary w-full text-base py-3.5">
        {busy ? "กำลังบันทึก..." : "เริ่มใช้งาน"}
      </button>

      <p className="text-[10px] text-slate-400 text-center">
        จดข้อมูลที่ตั้งไว้ให้ดี — ถ้าลืม กรุณาขอให้ผู้ดูแลระบบรีเซตให้
      </p>
    </form>
  );
}
