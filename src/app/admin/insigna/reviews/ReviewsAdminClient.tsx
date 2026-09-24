"use client";

import { useState } from "react";

type Branch = { id: number; name: string; slug: string; url: string };

async function post(body: unknown): Promise<{ ok: boolean; result?: string }> {
  const res = await fetch("/api/admin/insigna/reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json().catch(() => ({ ok: false }));
}

export default function ReviewsAdminClient({
  initialEnabled, initialRewardText, initialThreshold, branches
}: {
  initialEnabled: boolean; initialRewardText: string; initialThreshold: number; branches: Branch[];
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [rewardText, setRewardText] = useState(initialRewardText);
  const [threshold, setThreshold] = useState(initialThreshold);
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgMsg, setCfgMsg] = useState<string | null>(null);

  const [urls, setUrls] = useState<Record<number, string>>(
    Object.fromEntries(branches.map((b) => [b.id, b.url]))
  );
  const [branchMsg, setBranchMsg] = useState<Record<number, string>>({});

  const [claimCode, setClaimCode] = useState("");
  const [claimMsg, setClaimMsg] = useState<string | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  async function saveConfig() {
    setSavingCfg(true);
    setCfgMsg(null);
    const r = await post({ action: "config", enabled, reward_text: rewardText.trim() || null, high_threshold: threshold });
    setSavingCfg(false);
    setCfgMsg(r.ok ? "บันทึกแล้ว ✓" : "บันทึกไม่สำเร็จ");
    setTimeout(() => setCfgMsg(null), 2500);
  }

  async function saveBranch(b: Branch) {
    const r = await post({ action: "branch_url", branch_id: b.id, url: urls[b.id]?.trim() || null });
    setBranchMsg((m) => ({ ...m, [b.id]: r.ok ? "บันทึกแล้ว ✓" : "ผิดพลาด" }));
    setTimeout(() => setBranchMsg((m) => ({ ...m, [b.id]: "" })), 2500);
  }

  async function doClaim() {
    if (!claimCode.trim()) return;
    const r = await post({ action: "claim", reward_code: claimCode.trim() });
    const label = r.result === "claimed" ? "✓ ใช้สิทธิ์สำเร็จ"
      : r.result === "already" ? "โค้ดนี้ถูกใช้ไปแล้ว"
      : r.result === "same_day" ? "ใช้ในวันที่ทำแบบประเมินไม่ได้ · ใช้ได้ในครั้งถัดไปที่มาใช้บริการ"
      : r.result === "already_redeemed" ? "ลูกค้าท่านนี้ใช้สิทธิ์ที่สาขานี้ไปแล้ว (1 สิทธิ์ต่อสาขา)"
      : "ไม่พบโค้ดนี้";
    setClaimMsg(label);
    if (r.result === "claimed") setClaimCode("");
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* ── Config ── */}
      <div className="card space-y-3">
        <h2 className="text-sm font-bold text-slate-700">ตั้งค่าระบบรีวิว</h2>

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm text-slate-600">เปิดรับรีวิวจากลูกค้า</span>
          <button
            type="button"
            onClick={() => setEnabled((v) => !v)}
            className={`relative h-6 w-11 rounded-full transition ${enabled ? "bg-emerald-500" : "bg-slate-300"}`}
            aria-pressed={enabled}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${enabled ? "left-[22px]" : "left-0.5"}`} />
          </button>
        </label>

        <div>
          <label className="label">ของแลกเมื่อกรอกแบบประเมินครบ</label>
          <input
            className="input"
            value={rewardText}
            maxLength={200}
            onChange={(e) => setRewardText(e.target.value)}
            placeholder="เช่น รับเครื่องดื่มฟรี 1 แก้ว รอบหน้า"
          />
          <p className="text-[11px] text-slate-400 mt-1">
            ว่างไว้ = ไม่มีของแลก · ให้กับ “การกรอกแบบประเมิน” ไม่ใช่กับคะแนนหรือการรีวิว Google
          </p>
        </div>

        <div>
          <label className="label">เกณฑ์ดาวที่ถือว่า “พอใจ” (คำเชิญรีวิวจะเชิงบวก)</label>
          <select className="input" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
            <option value={3}>ตั้งแต่ 3★ ขึ้นไป</option>
            <option value={4}>ตั้งแต่ 4★ ขึ้นไป</option>
            <option value={5}>เฉพาะ 5★</option>
          </select>
          <p className="text-[11px] text-slate-400 mt-1">
            ลิงก์ Google โชว์ทุกคนอยู่แล้ว — เกณฑ์นี้แค่ปรับ “น้ำเสียง” คำเชิญ และจัดคิวหลังบ้าน
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button type="button" onClick={saveConfig} disabled={savingCfg}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white disabled:opacity-40">
            {savingCfg ? "กำลังบันทึก…" : "บันทึกการตั้งค่า"}
          </button>
          {cfgMsg && <span className="text-sm text-emerald-600">{cfgMsg}</span>}
        </div>
      </div>

      {/* ── Reward claim ── */}
      <div className="card space-y-3">
        <h2 className="text-sm font-bold text-slate-700">ใช้สิทธิ์ของแลก (พนักงานหน้าร้าน)</h2>
        <p className="text-[11px] text-slate-400">ลูกค้าแสดงโค้ด IK-XXXXXX รอบถัดไป — พิมพ์โค้ดแล้วกดใช้สิทธิ์</p>
        <div className="flex gap-2">
          <input
            className="input font-mono uppercase"
            value={claimCode}
            onChange={(e) => { setClaimCode(e.target.value); setClaimMsg(null); }}
            placeholder="IK-XXXXXX"
          />
          <button type="button" onClick={doClaim}
            className="shrink-0 rounded-lg bg-slate-700 px-4 py-2 text-sm font-bold text-white">
            ใช้สิทธิ์
          </button>
        </div>
        {claimMsg && (
          <div className={`text-sm ${claimMsg.startsWith("✓") ? "text-emerald-600" : "text-rose-600"}`}>{claimMsg}</div>
        )}
      </div>

      {/* ── Per-branch Google link + QR link ── */}
      <div className="card lg:col-span-2 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-bold text-slate-700">ลิงก์ Google review + ลิงก์แบบฟอร์มต่อสาขา</h2>
          <a href="/admin/insigna/reviews/qr" target="_blank" rel="noopener noreferrer"
            className="text-xs font-semibold text-brand hover:underline">
            พิมพ์ QR ติดโต๊ะต่อสาขา ↗
          </a>
        </div>
        <p className="text-[11px] text-slate-400 -mt-2">
          ใช้ลิงก์เขียนรีวิวตรง <code className="bg-slate-100 px-1 rounded">https://search.google.com/local/writereview?placeid=…</code>
          {" "}(หา Place ID ได้จาก Google Business Profile) เพื่อให้ลูกค้าแตะแล้วเด้งหน้าดาวทันที
        </p>
        {branches.map((b) => (
          <div key={b.id} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="font-semibold text-slate-700 text-sm">{b.name}</span>
              <a href={`/f/${b.slug}`} target="_blank" rel="noopener noreferrer"
                className="text-xs text-brand hover:underline">
                เปิดฟอร์มลูกค้า: {origin}/f/{b.slug} ↗
              </a>
            </div>
            <div className="flex gap-2">
              <input
                className="input text-xs"
                value={urls[b.id] ?? ""}
                onChange={(e) => setUrls((u) => ({ ...u, [b.id]: e.target.value }))}
                placeholder="https://search.google.com/local/writereview?placeid=…"
              />
              <button type="button" onClick={() => saveBranch(b)}
                className="shrink-0 rounded-lg bg-brand px-3 py-2 text-sm font-bold text-white">
                บันทึก
              </button>
            </div>
            {branchMsg[b.id] && <div className="text-xs text-emerald-600">{branchMsg[b.id]}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
