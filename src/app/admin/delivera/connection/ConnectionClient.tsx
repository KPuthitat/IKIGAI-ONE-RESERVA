"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";

type ChannelView = {
  kind: "customer" | "rider";
  label: string;
  has_token: boolean;
  has_secret: boolean;
  liff_id: string;
  updated_at: string | null;
};

const ENDPOINT: Record<"customer" | "rider", string> = {
  customer: "https://ikigaimedihealth.com/delivera/order",
  rider: "https://ikigaimedihealth.com/delivera/rider"
};

export default function ConnectionClient({ customer, rider }: { customer: ChannelView; rider: ChannelView }) {
  return (
    <div className="space-y-4">
      <ChannelCard initial={customer} />
      <ChannelCard initial={rider} />
      <p className="text-[11px] text-slate-400">
        token/secret เก็บแบบเข้ารหัสในระบบ · LIFF ID ไม่ใช่ความลับ · ค่าที่กรอกมีผลทันที ไม่ต้อง deploy ใหม่ ·
        ช่องที่เว้นว่าง = ไม่แก้ค่าเดิม
      </p>
    </div>
  );
}

function ChannelCard({ initial }: { initial: ChannelView }) {
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [liff, setLiff] = useState(initial.liff_id);
  const [hasToken, setHasToken] = useState(initial.has_token);
  const [hasSecret, setHasSecret] = useState(initial.has_secret);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const ready = hasToken && hasSecret && !!liff.trim();

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const creds: Record<string, string> = {};
      if (token.trim()) creds.channel_token = token.trim();
      if (secret.trim()) creds.channel_secret = secret.trim();
      creds.liff_id = liff.trim();   // always sent (empty clears it)
      const res = await fetch(apiUrl("/api/admin/delivera/connection"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: initial.kind, creds })
      });
      if (!res.ok) { setMsg("บันทึกไม่สำเร็จ"); return; }
      if (token.trim()) setHasToken(true);
      if (secret.trim()) setHasSecret(true);
      setToken(""); setSecret("");
      setMsg("บันทึกแล้ว");
      setTimeout(() => setMsg(null), 1800);
    } finally { setBusy(false); }
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-slate-800">{initial.label}</h2>
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${ready ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
          {ready ? "พร้อมใช้งาน" : "ยังไม่ครบ"}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label !text-xs">Channel access token {hasToken && <span className="text-emerald-600">· มีแล้ว</span>}</label>
          <input className="input font-mono" type="password" value={token} onChange={(e) => setToken(e.target.value)}
            placeholder={hasToken ? "•••••• (เว้นว่างถ้าไม่เปลี่ยน)" : "วาง token"} />
        </div>
        <div>
          <label className="label !text-xs">Channel secret {hasSecret && <span className="text-emerald-600">· มีแล้ว</span>}</label>
          <input className="input font-mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
            placeholder={hasSecret ? "•••••• (เว้นว่างถ้าไม่เปลี่ยน)" : "วาง secret"} />
        </div>
      </div>
      <div>
        <label className="label !text-xs">LIFF ID</label>
        <input className="input font-mono" value={liff} onChange={(e) => setLiff(e.target.value)} placeholder="เช่น 2001234567-abcdEFgh" />
        <p className="text-[11px] text-slate-400 mt-1">Endpoint LIFF: <span className="font-mono">{ENDPOINT[initial.kind]}</span></p>
      </div>

      {liff.trim() && (
        <p className="text-[11px] text-slate-500">
          ลิงก์เปิดใช้: <span className="font-mono break-all">https://liff.line.me/{liff.trim()}{initial.kind === "customer" ? "?branch=1" : "?branch=1"}</span>
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={busy} className="rounded-md bg-brand text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
          {busy ? "กำลังบันทึก…" : "บันทึก"}
        </button>
        {msg && <span className="text-[12px] text-emerald-700">{msg}</span>}
        {initial.updated_at && <span className="text-[11px] text-slate-400">แก้ล่าสุด {initial.updated_at.slice(0, 16).replace("T", " ")}</span>}
      </div>
    </div>
  );
}
