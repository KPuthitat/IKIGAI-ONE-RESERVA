"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";

// Test buttons grouped by audience. Each card has its own button +
// inline result line ("✓ ส่งสำเร็จ" / "✗ <reason>") so admin can
// iterate quickly without scrolling back to a single result area.
//
// We intentionally don't show much UX polish — this is a QA tool, not
// a customer-facing surface.

type TestKind =
  | "shift_work"
  | "shift_day_off"
  | "shift_on_leave"
  | "clock_in"
  | "attendance_summary";

type ButtonDef = {
  kind: TestKind;
  label: string;
  desc: string;
  audience: "self" | "group";
};

const SELF_DM: ButtonDef[] = [
  {
    kind: "shift_work",
    label: "เวรประจำวัน (work)",
    desc: "การ์ดเขียวมรกต · ตำแหน่ง + เวลา + 'อย่าลืมลงเวลา'",
    audience: "self"
  },
  {
    kind: "shift_day_off",
    label: "วันหยุด (day_off)",
    desc: "การ์ดเหลือง · 'วันนี้เป็นวันของพี่'",
    audience: "self"
  },
  {
    kind: "shift_on_leave",
    label: "วันลา (on_leave)",
    desc: "การ์ดฟ้า · ระบุประเภทลา (ตัวอย่างใช้ 'ลาป่วย')",
    audience: "self"
  },
  {
    kind: "clock_in",
    label: "ยืนยันการลงเวลาเข้างาน",
    desc: "การ์ด ink-navy · เวลาเข้า / พักกลางวัน / เวลาออก",
    audience: "self"
  }
];

const GROUP_DM: ButtonDef[] = [
  {
    kind: "attendance_summary",
    label: "สรุปการเข้างานประจำวัน",
    desc: "ส่งเข้ากลุ่ม executive · ตัวอย่างมีครบ 5 หมวด",
    audience: "group"
  }
];

export default function TestNotificationsClient() {
  return (
    <div className="space-y-6">
      <Section title="📲 ส่งเข้า LINE ของคุณ (DM)"
               hint="ต้องผูก LINE ที่ /staff/persona/profile ก่อน">
        <div className="grid sm:grid-cols-2 gap-3">
          {SELF_DM.map((b) => <TestButton key={b.kind} {...b} />)}
        </div>
      </Section>

      <Section title="👥 ส่งเข้ากลุ่ม Executive"
               hint="ตั้งค่า global_staff_group_id ที่ /admin/system-settings ก่อน">
        <div className="grid sm:grid-cols-2 gap-3">
          {GROUP_DM.map((b) => <TestButton key={b.kind} {...b} />)}
        </div>
      </Section>
    </div>
  );
}

function Section({
  title, hint, children
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-lg font-bold text-slate-800">{title}</h2>
      <p className="text-xs text-slate-500 mb-3">{hint}</p>
      {children}
    </section>
  );
}

function TestButton({ kind, label, desc }: ButtonDef) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function fire() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/test-notification"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setResult({
          kind: "ok",
          text: `ส่งเข้า ${j.sent_to === "executive_group" ? "กลุ่ม executive" : "LINE ของคุณ"} แล้ว`
        });
      } else {
        const map: Record<string, string> = {
          no_line_bound: "ยังไม่ได้ผูก LINE — ผูกที่ /staff/persona/profile ก่อน",
          platform_channel_not_ready: "ตั้งค่า LINE OA token + secret ที่ /admin/persona/messaging ก่อน",
          group_push_failed: `ส่งเข้ากลุ่มไม่สำเร็จ — ${j.detail ?? ""}`,
          push_failed: `ส่งไม่สำเร็จ — ${j.detail ?? ""}`,
          forbidden: "ต้องเป็น admin"
        };
        setResult({
          kind: "err",
          text: map[j.error] || j.error || `HTTP ${res.status}`
        });
      }
    } catch (e) {
      setResult({
        kind: "err",
        text: e instanceof Error ? e.message : "network_error"
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-2">
      <div>
        <div className="font-bold text-slate-800 text-sm">{label}</div>
        <div className="text-xs text-slate-500 mt-0.5">{desc}</div>
      </div>
      <button
        type="button"
        onClick={fire}
        disabled={busy}
        className="btn-primary text-sm w-full disabled:opacity-50"
      >
        {busy ? "กำลังส่ง…" : "📨 ส่งทดสอบ"}
      </button>
      {result && (
        <div className={`text-xs ${result.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
          {result.kind === "ok" ? "✓ " : "✗ "}{result.text}
        </div>
      )}
    </div>
  );
}
