"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";

export default function SettingsClient({
  code, label, hasSecret, hasToken, liffId, liffIdStatus, oaLink, oaLinkDefault, webhookUrl
}: {
  code: string;
  label: string;
  hasSecret: boolean;
  hasToken: boolean;
  liffId: string;
  liffIdStatus: string;
  oaLink: string;
  oaLinkDefault: string;
  webhookUrl: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [liff, setLiff] = useState(liffId);
  const [liffStatus, setLiffStatus] = useState(liffIdStatus);
  const [oa, setOa] = useState(oaLink);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* ignore */ }
  }

  async function save() {
    setErr(null); setMsg(null);
    setBusy(true);
    try {
      const body: Record<string, string> = {};
      if (secret.trim()) body.channel_secret = secret.trim();
      if (token.trim()) body.channel_token = token.trim();
      if (liff !== liffId) body.liff_id = liff.trim();
      if (liffStatus !== liffIdStatus) body.liff_id_status = liffStatus.trim();
      if (oa !== oaLink) body.oa_link = oa.trim();
      if (Object.keys(body).length === 0) {
        setMsg("ไม่มีค่าใหม่ที่จะบันทึก");
        return;
      }
      const res = await fetch(apiUrl(`/api/recruita/settings/channel`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ"));
        return;
      }
      setMsg("✓ บันทึกเรียบร้อย");
      setSecret(""); setToken("");
      startTransition(() => router.refresh());
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      {/* Status pills */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">สถานะการเชื่อมต่อ</h2>
        <div className="flex gap-2 flex-wrap">
          <Pill ok={hasSecret} label="Channel Secret" />
          <Pill ok={hasToken} label="Access Token" />
          <Pill ok={!!liffId} label={`LIFF (สมัครงาน)${liffId ? ` · ${liffId}` : ""}`} />
          <Pill ok={!!liffIdStatus} label={`LIFF (เช็คสถานะ)${liffIdStatus ? ` · ${liffIdStatus}` : ""}`} />
        </div>
        <p className="text-[11px] text-slate-500">
          {hasSecret && hasToken
            ? "✅ ระบบพร้อมส่งแจ้งเตือนผ่าน LINE OA นี้"
            : "⚠️ ต้องใส่ Channel Secret + Access Token จึงจะส่งข้อความได้"}
        </p>
      </div>

      {/* Webhook URL — copy to LINE Developers Console */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">Webhook URL</h2>
        <p className="text-xs text-slate-500">
          คัดลอก URL ด้านล่าง ไปวางที่ <b>LINE Developers Console → Messaging API → Webhook URL</b>
        </p>
        <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded p-2">
          <code className="flex-1 text-xs font-mono break-all">{webhookUrl}</code>
          <button type="button" onClick={() => copy(webhookUrl, "webhook")}
            className="text-xs px-3 py-1.5 rounded bg-brand text-white font-bold whitespace-nowrap">
            {copied === "webhook" ? "✓ คัดลอกแล้ว" : "คัดลอก"}
          </button>
        </div>
        <p className="text-[10px] text-slate-400">
          อย่าลืมเปิด <b>Use webhook = ON</b> และตั้ง <b>Auto-reply = OFF</b> (ระบบจะตอบเอง)
        </p>
      </div>

      {/* Credential form */}
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">ใส่ Credentials</h2>
        <p className="text-xs text-slate-500">
          ค่าทั้งหมดอยู่ที่ <b>LINE Developers Console → {label} channel → Messaging API tab</b>
        </p>

        <div>
          <label className="label">
            Channel Secret
            {hasSecret && <span className="ml-1 text-[10px] text-emerald-600 font-bold">(เก็บไว้แล้ว — ใส่ใหม่เพื่อเปลี่ยน)</span>}
          </label>
          <input className="input font-mono text-xs" type="password"
            value={secret} onChange={(e) => setSecret(e.target.value)}
            placeholder={hasSecret ? "•••••••••••••• (ค่าเดิม)" : "วาง Channel secret ที่นี่"} />
        </div>

        <div>
          <label className="label">
            Channel Access Token (long-lived)
            {hasToken && <span className="ml-1 text-[10px] text-emerald-600 font-bold">(เก็บไว้แล้ว — ใส่ใหม่เพื่อเปลี่ยน)</span>}
          </label>
          <textarea className="input font-mono text-xs" rows={3}
            value={token} onChange={(e) => setToken(e.target.value)}
            placeholder={hasToken ? "•••••••••••••• (ค่าเดิม)" : "วาง Access token ที่นี่"} />
        </div>

        <div>
          <label className="label">LIFF ID — สำหรับปุ่ม &quot;สมัครงาน&quot;</label>
          <input className="input font-mono text-xs"
            value={liff} onChange={(e) => setLiff(e.target.value)}
            placeholder="เช่น 1234567890-AbCdEfGh" />
          <p className="text-[10px] text-slate-400 mt-0.5">
            LIFF app ที่ตั้ง endpoint = <code>/recruita/positions</code> หรือ <code>/recruita/apply/[id]</code>
            <br />ใช้เก็บ LINE userId ของผู้สมัครตอนกรอกฟอร์ม
          </p>
        </div>

        <div>
          <label className="label">LIFF ID — สำหรับปุ่ม &quot;เช็คสถานะ&quot;</label>
          <input className="input font-mono text-xs"
            value={liffStatus} onChange={(e) => setLiffStatus(e.target.value)}
            placeholder="เช่น 1234567890-XyZpQrSt" />
          <p className="text-[10px] text-slate-400 mt-0.5">
            LIFF app ที่ตั้ง endpoint = <code>/recruita/status</code>
            <br />ผู้สมัครกดปุ่มนี้แล้วเห็นสถานะใบสมัครของตัวเอง
            <br /><span className="text-amber-600">ใส่แค่ ID ล้วน เช่น <code>2010245034-x1TBNhAv</code> ห้ามใส่ URL เต็ม</span>
          </p>
        </div>

        <div>
          <label className="label">ลิงก์เพิ่มเพื่อน OA (สำหรับคนที่เปิดฟอร์มนอก LINE)</label>
          <input className="input font-mono text-xs"
            value={oa} onChange={(e) => setOa(e.target.value)}
            placeholder={oaLinkDefault} />
          <p className="text-[10px] text-slate-400 mt-0.5">
            เมื่อผู้สมัครเปิดหน้าสมัครงาน<b>นอกแอป LINE</b> ระบบจะล็อกฟอร์มและแสดงปุ่มนี้ให้ไปเพิ่มเพื่อน OA
            แล้วกลับเข้ามาผ่าน Rich Menu (เพื่อเก็บ LINE userId).
            <br />ปล่อยว่าง = ใช้ค่าเริ่มต้น <code>{oaLinkDefault}</code>
          </p>
        </div>

        {err && <div className="text-rose-600 text-sm">✗ {err}</div>}
        {msg && <div className="text-emerald-700 text-sm font-bold">{msg}</div>}

        <button type="button" onClick={save} disabled={busy}
          className="btn-primary w-full disabled:opacity-50">
          {busy ? "กำลังบันทึก…" : "บันทึกค่า"}
        </button>
      </div>

      {/* Hint card */}
      <div className="card bg-sky-50 border border-sky-200 space-y-2 text-xs">
        <h3 className="font-bold text-sky-900 text-sm">ขั้นตอนการตั้งค่า OA</h3>
        <ol className="list-decimal list-inside space-y-1 text-sky-900 leading-relaxed">
          <li>เข้า <a href="https://developers.line.biz/console/" target="_blank" rel="noopener noreferrer" className="underline">LINE Developers Console</a> เลือก provider ของคุณ</li>
          <li>เลือก channel <b>IKIGAI Recruit</b> (หรือสร้างใหม่ถ้ายังไม่มี → Messaging API)</li>
          <li>คัดลอก <b>Channel Secret</b> จาก Basic Settings tab</li>
          <li>คัดลอก <b>Channel Access Token (long-lived)</b> จาก Messaging API tab (อาจต้องกด Issue)</li>
          <li>วาง webhook URL ด้านบน → กด Verify → เปิด Use webhook</li>
          <li>ปิด Auto-reply messages, Greeting messages ตามต้องการ (ระบบจะส่งเอง)</li>
        </ol>
      </div>
    </div>
  );
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`text-xs px-2.5 py-1 rounded-full font-bold ${
      ok ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"
    }`}>
      {ok ? "✓" : "○"} {label}
    </span>
  );
}
