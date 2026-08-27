"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";

// Client form for editing a branch's approval tiers. Two parallel
// multi-selects, one per tier. Validation rule: each tier must have
// at least 1 selection (else /api/persona/leave will reject new
// submissions for the branch). UX gives a clear "ยังขาด" banner if
// either tier is empty.
//
// Design choice: we save BOTH tiers in one POST rather than per-tier
// saves, so the admin can re-organise (e.g. promote a supervisor to
// executive) atomically — no in-between state where someone is on
// both tiers or neither.

export type EligibleUser = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  nickname_th: string | null;
  role: "staff" | "admin" | "super_admin";
};

export default function ApprovalChainClient({
  branchId,
  branchName,
  eligible,
  initialTier1,
  initialTier2
}: {
  branchId: number;
  branchName: string;
  eligible: EligibleUser[];
  initialTier1: number[];
  initialTier2: number[];
}) {
  const router = useRouter();
  const [tier1, setTier1] = useState<Set<number>>(new Set(initialTier1));
  const [tier2, setTier2] = useState<Set<number>>(new Set(initialTier2));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Mirror map for fast lookups when rendering chips.
  const byId = useMemo(() => {
    const m = new Map<number, EligibleUser>();
    for (const u of eligible) m.set(u.id, u);
    return m;
  }, [eligible]);

  function toggle(tier: 1 | 2, userId: number) {
    const s = tier === 1 ? new Set(tier1) : new Set(tier2);
    if (s.has(userId)) s.delete(userId);
    else s.add(userId);
    if (tier === 1) setTier1(s);
    else setTier2(s);
    // A user on both tiers is allowed (a supervisor who's also an
    // executive) — useful at small clinics. But the self-skip rule
    // means their own leave will route to the other tier members.
  }

  async function save() {
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/approval-chain"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch_id: branchId,
          tier1: Array.from(tier1),
          tier2: Array.from(tier2)
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message || j.error || "บันทึกไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: "บันทึกสายบังคับบัญชาเรียบร้อย" });
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: "เกิดข้อผิดพลาด" });
    } finally {
      setBusy(false);
    }
  }

  const ready = tier1.size > 0 && tier2.size > 0;

  return (
    <div className="space-y-4">
      {!ready && (
        <div className="card bg-amber-50 border-amber-200 text-xs text-amber-800">
          ทั้งสองชั้นต้องมีอย่างน้อย 1 คน — มิเช่นนั้นพนักงานสาขา{" "}
          <span className="font-semibold">{branchName}</span>{" "}
          จะส่งคำขอลา / ลาออก ไม่ได้
        </div>
      )}

      <TierCard
        tier={1}
        title="ชั้นที่ 1 — หัวหน้างาน"
        help="เมื่อพนักงานส่งคำขอลา ระบบจะแจ้งทุกคนในชั้นนี้ ใครก็ได้ในชั้นนี้กดอนุมัติ 1 คน = ผ่านไปชั้นที่ 2"
        eligible={eligible}
        selected={tier1}
        byId={byId}
        onToggle={(uid) => toggle(1, uid)}
      />

      <div className="flex justify-center text-slate-400">↓</div>

      <TierCard
        tier={2}
        title="ชั้นที่ 2 — ผู้บริหาร"
        help="หลังผ่านชั้นที่ 1 ระบบจะแจ้งทุกคนในชั้นนี้ ใครก็ได้ในชั้นนี้กดอนุมัติ 1 คน = คำขอผ่านสมบูรณ์"
        eligible={eligible}
        selected={tier2}
        byId={byId}
        onToggle={(uid) => toggle(2, uid)}
      />

      <div className="card bg-slate-50 border-slate-200 text-[11px] text-slate-600 space-y-1">
        <div className="font-bold text-slate-700">เกร็ดการตั้งค่า</div>
        <div>· ถ้าผู้ขอลาเองอยู่ในชั้นที่ 1 → ระบบจะข้ามไปให้ชั้นที่ 2 อนุมัติเลย</div>
        <div>· ถ้าผู้ขอลาเองอยู่ในชั้นที่ 2 → คนอื่นในชั้นที่ 2 อนุมัติแทน</div>
        <div>· หัวหน้าไม่ตัดสินใจใน {`{escalation hours}`} ชั่วโมง → ระบบข้ามไปให้ชั้นที่ 2 ได้ทันที</div>
        <div>· คนเดียวกันอยู่ทั้ง 2 ชั้นได้ (เช่น คลินิกเล็กที่หัวหน้า = ผู้บริหาร)</div>
      </div>

      {msg && (
        <div className={`text-sm text-center ${
          msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
        }`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
        </div>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={save}
        className="btn-primary w-full text-base py-3.5"
      >
        {busy ? "กำลังบันทึก…" : "บันทึก"}
      </button>
    </div>
  );
}

function TierCard({
  title,
  help,
  eligible,
  selected,
  byId,
  onToggle
}: {
  tier: 1 | 2;
  title: string;
  help: string;
  eligible: EligibleUser[];
  selected: Set<number>;
  byId: Map<number, EligibleUser>;
  onToggle: (userId: number) => void;
}) {
  return (
    <div className="card space-y-3">
      <div>
        <h3 className="font-bold text-slate-800 text-sm">{title}</h3>
        <p className="text-xs text-slate-500 mt-1">{help}</p>
      </div>

      {/* Currently selected as chips at the top */}
      {selected.size > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {Array.from(selected).map((uid) => {
            const u = byId.get(uid);
            if (!u) return null;
            return (
              <button
                key={uid}
                type="button"
                onClick={() => onToggle(uid)}
                className="text-[11px] bg-brand text-white rounded px-2 py-0.5 hover:bg-brand-dark"
                title="คลิกเพื่อเอาออก"
              >
                {nameWithPrefix(u.title_prefix, u.display_name)}
                {u.role === "admin" && " (แอดมิน)"}
                {u.role === "super_admin" && " (ซูเปอร์)"}
                <span className="ml-1">×</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="text-[11px] text-rose-500">— ยังไม่ได้เลือกใคร —</div>
      )}

      <div className="border-t border-slate-100 pt-3">
        <div className="text-[10px] text-slate-400 uppercase tracking-[0.5px] mb-1.5">
          เลือกจากพนักงานในสาขา
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
          {eligible.map((u) => {
            const isSelected = selected.has(u.id);
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => onToggle(u.id)}
                className={`text-left text-xs rounded px-2 py-1.5 transition-colors ${
                  isSelected
                    ? "bg-brand/10 text-brand font-semibold"
                    : "bg-slate-50 text-slate-700 hover:bg-slate-100"
                }`}
              >
                <span className="inline-block w-4">{isSelected ? "✓" : ""}</span>
                {nameWithPrefix(u.title_prefix, u.display_name)}
                {u.role === "admin" && (
                  <span className="ml-1 text-[10px] text-amber-600">(แอดมิน)</span>
                )}
                {u.role === "super_admin" && (
                  <span className="ml-1 text-[10px] text-purple-600">(ซูเปอร์)</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
