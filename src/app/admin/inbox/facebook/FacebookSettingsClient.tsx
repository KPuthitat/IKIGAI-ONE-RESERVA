"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";

type Channel = {
  page_id: string; page_name: string | null; branch_id: number | null;
  has_verify_token: boolean; has_access_token: boolean; has_app_secret: boolean;
};
type Branch = { id: number; name: string };

export default function FacebookSettingsClient() {
  const [loading, setLoading] = useState(true);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [existing, setExisting] = useState<Channel | null>(null);

  const [pageId, setPageId] = useState("");
  const [pageName, setPageName] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [branchId, setBranchId] = useState<string>("");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");

  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    fetch(apiUrl("/api/admin/inbox/facebook")).then((r) => r.json()).then((j) => {
      if (j?.ok) {
        setBranches(j.branches ?? []);
        setWebhookUrl(j.webhookUrl ?? "");
        const c: Channel | undefined = (j.channels ?? [])[0];
        if (c) {
          setExisting(c);
          setPageId(c.page_id); setPageName(c.page_name ?? "");
          setBranchId(c.branch_id != null ? String(c.branch_id) : "");
          // verify token is a secret — not sent back; leave blank (keeps stored).
        }
      }
    }).catch(() => { /* ignore */ }).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    if (!pageId.trim()) { setMsg({ kind: "err", text: "กรอก Page ID" }); return; }
    if (!verifyToken.trim() && !existing?.has_verify_token) { setMsg({ kind: "err", text: "กรอก Verify Token" }); return; }
    setSaving(true); setMsg(null);
    try {
      const r = await fetch(apiUrl("/api/admin/inbox/facebook"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page_id: pageId.trim(), page_name: pageName.trim() || null,
          branch_id: branchId ? Number(branchId) : null,
          ...(verifyToken.trim() ? { verify_token: verifyToken.trim() } : {}),
          ...(accessToken.trim() ? { access_token: accessToken.trim() } : {}),
          ...(appSecret.trim() ? { app_secret: appSecret.trim() } : {})
        })
      }).then((x) => x.json());
      if (r?.ok) {
        setMsg({ kind: "ok", text: "บันทึกแล้ว" });
        setAccessToken(""); setAppSecret(""); setVerifyToken("");
        setExisting((e) => ({
          page_id: pageId.trim(), page_name: pageName.trim() || null, branch_id: branchId ? Number(branchId) : null,
          has_verify_token: (e?.has_verify_token || !!verifyToken.trim()),
          has_access_token: e?.has_access_token || !!accessToken.trim(),
          has_app_secret: e?.has_app_secret || !!appSecret.trim()
        }));
      } else setMsg({ kind: "err", text: r?.error === "forbidden" ? "เฉพาะ super admin" : "บันทึกไม่สำเร็จ" });
    } catch { setMsg({ kind: "err", text: "บันทึกผิดพลาด" }); }
    setSaving(false);
  };

  if (loading) return <div className="card text-sm text-slate-400">กำลังโหลด…</div>;

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        {msg && <div className={`text-sm rounded-lg px-3 py-2 ${msg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</div>}
        <div>
          <label className="label">Page ID (เลขหน้าเพจ Facebook)</label>
          <input value={pageId} onChange={(e) => setPageId(e.target.value)} className="input" placeholder="เช่น 1234567890" />
        </div>
        <div>
          <label className="label">ชื่อเพจ (ไว้ดูอ้างอิง)</label>
          <input value={pageName} onChange={(e) => setPageName(e.target.value)} className="input" placeholder="เช่น IKIGAI Clinic" />
        </div>
        <div>
          <label className="label">Verify Token (ตั้งเอง — ใช้ตอนตั้ง Webhook ใน Meta) {existing?.has_verify_token && <span className="text-emerald-600 text-xs">· บันทึกไว้แล้ว</span>}</label>
          <input type="password" autoComplete="off" value={verifyToken} onChange={(e) => setVerifyToken(e.target.value)} className="input"
            placeholder={existing?.has_verify_token ? "•••••• (เว้นว่างเพื่อคงค่าเดิม)" : "เช่น ikigai-fb-verify-xxxx"} />
        </div>
        <div>
          <label className="label">สาขาที่รับแชทเพจนี้</label>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="input">
            <option value="">— ไม่ผูกสาขา (super admin เห็นทั้งหมด) —</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Page Access Token {existing?.has_access_token && <span className="text-emerald-600 text-xs">· บันทึกไว้แล้ว</span>}</label>
          <input type="password" autoComplete="off" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} className="input"
            placeholder={existing?.has_access_token ? "•••••• (เว้นว่างเพื่อคงค่าเดิม)" : "วาง Page Access Token"} />
        </div>
        <div>
          <label className="label">App Secret {existing?.has_app_secret && <span className="text-emerald-600 text-xs">· บันทึกไว้แล้ว</span>}</label>
          <input type="password" autoComplete="off" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} className="input"
            placeholder={existing?.has_app_secret ? "•••••• (เว้นว่างเพื่อคงค่าเดิม)" : "วาง App Secret (ใช้ตรวจลายเซ็น webhook)"} />
        </div>
        <button type="button" onClick={save} disabled={saving} className="btn-primary text-sm px-4 py-2 disabled:opacity-50">
          {saving ? "กำลังบันทึก…" : "บันทึก"}
        </button>
      </div>

      <div className="card space-y-2 text-sm">
        <div className="font-bold text-slate-800">วิธีตั้งค่าฝั่ง Meta</div>
        <ol className="list-decimal ml-5 space-y-1 text-slate-600 text-[13px]">
          <li>สร้าง Meta App (developers.facebook.com) → เพิ่มผลิตภัณฑ์ <b>Messenger</b> → ผูกเพจ แล้วออก <b>Page Access Token</b> มากรอกด้านบน</li>
          <li>คัดลอก <b>App Secret</b> (Settings → Basic) มากรอกด้านบน</li>
          <li>ที่ Messenger → Webhooks ใส่ <b>Callback URL</b> ด้านล่างนี้ และ <b>Verify Token</b> ให้ตรงกับที่กรอกไว้ แล้วสมัครรับ event <code>messages</code></li>
        </ol>
        <div>
          <label className="label">Callback URL (Webhook)</label>
          <input readOnly value={webhookUrl} onClick={(e) => (e.target as HTMLInputElement).select()} className="input font-mono text-xs" />
        </div>
        <p className="text-[12px] text-slate-400">บันทึก Verify Token + Page ให้เรียบร้อยก่อน แล้วค่อยกด Verify ฝั่ง Meta — ระบบจะยืนยัน handshake ให้อัตโนมัติ</p>
      </div>
    </div>
  );
}
