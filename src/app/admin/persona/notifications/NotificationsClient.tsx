"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import FlexPreview from "./FlexPreview";

// Per-template editor + LINE-approximate preview. Each template is
// its own <TemplateEditor /> block so adding the next one (approval
// notify, daily attendance summary) is a copy-paste of the shape.

const DEFAULT_UNLOCK_BODY =
  "{ADMIN} เพิ่งเปิดสิทธิ์ยื่นใบลาออกให้พี่แล้วครับ — ถ้าพี่ต้องการยื่น สามารถเข้าไปกรอกแบบฟอร์มได้ที่ปุ่มด้านล่าง";

// Mirror of DEFAULT_SHIFT_GREETINGS in src/lib/line.ts. Kept in sync
// by hand because importing from a server-side module here would pull
// better-sqlite3 into the browser bundle. The strings shown in the
// textarea placeholder are the same fallback pool that runs on the
// server when the admin leaves a kind blank.
const DEFAULT_SHIFT_GREETINGS = {
  work: [
    "สวัสดีครับพี่{NAME} น้องฮูกแวะมาทักทาย",
    "อรุณสวัสดิ์ครับพี่{NAME} น้องฮูกแวะมาทักทาย",
    "สวัสดีตอนเช้าครับพี่{NAME} น้องฮูกแวะมาทักทาย",
    "หวัดดีครับพี่{NAME} น้องฮูกขออนุญาตรายงานเวรประจำวัน",
    "สวัสดีครับพี่{NAME} น้องฮูกพร้อมเริ่มวันใหม่ไปกับพี่"
  ],
  day_off: [
    "สวัสดีตอนเช้าครับพี่{NAME} วันนี้พักผ่อนเต็มที่นะครับ",
    "อรุณสวัสดิ์ครับพี่{NAME} วันนี้น้องดูแลร้านให้ พี่พักได้สบายใจ",
    "สวัสดีครับพี่{NAME} วันนี้เป็นวันของพี่ ขอให้พี่มีความสุข",
    "หวัดดีครับพี่{NAME} วันนี้พักนะครับ น้องฝากรอยยิ้มไว้ให้พี่"
  ],
  on_leave: [
    "สวัสดีครับพี่{NAME} น้องฮูกแจ้งเรื่องวันลาของพี่นะครับ",
    "สวัสดีครับพี่{NAME} บันทึกการลาของพี่เรียบร้อย น้องดูแลให้แล้ว",
    "หวัดดีครับพี่{NAME} การลาของพี่ผ่านการอนุมัติแล้วครับ",
    "สวัสดีครับพี่{NAME} น้องขอให้พี่หายไวๆ กลับมาสดชื่นนะครับ"
  ]
} as const;

type ShiftKind = "work" | "day_off" | "on_leave";

export default function NotificationsClient({
  resignationUnlockMessage,
  shiftGreetings
}: {
  resignationUnlockMessage: string;
  shiftGreetings: Record<ShiftKind, string>;
}) {
  return (
    <div className="space-y-6">
      <ShiftReminderEditor initial={shiftGreetings} />
      <ResignationUnlockEditor initial={resignationUnlockMessage} />

      <div className="card bg-slate-50 border-slate-200 text-[11px] text-slate-500 space-y-1">
        <div className="font-bold text-slate-600">การ์ดอื่นที่จะปรับแต่งได้ในเฟสถัดไป</div>
        <div>· การ์ดแจ้งเตือนคำขอลา (submitted / approved / rejected / escalated)</div>
        <div>· การ์ดสรุปการเข้างานรายวัน (รายงานเข้ากลุ่มผู้บริหาร)</div>
      </div>
    </div>
  );
}

// ── Template 1: Daily shift reminder greeting ──────────────────────

// One textarea per kind. Newline-separates the rotation pool. Empty
// → fall back to defaults (shown as placeholder so admin sees what
// they'd lose by saving empty). Each kind has its own preview so the
// admin can spot wrapping issues per-kind.

const KIND_META: Record<ShiftKind, {
  label: string;
  badge: string;          // shown on the preview as the green banner label
  bannerColor: string;    // matches lib/line.ts bannerColorByKind
  closing: string;        // matches pickShiftClosing()
  body: string;           // the body line under the greeting
}> = {
  work: {
    label: "วันที่มีเวร",
    badge: "PASTA",
    bannerColor: "#10b981",
    closing: "อย่าลืมลงเวลาเข้างานนะครับ น้องเอาใจช่วย",
    body: "08:00 – 16:00 น. · NPF"
  },
  day_off: {
    label: "วันหยุด",
    badge: "วันหยุดของพี่",
    bannerColor: "#f59e0b",
    closing: "ขอให้พี่มีวันหยุดที่ดีนะครับ",
    body: "วันนี้พี่ไม่มีเวร พักผ่อนเต็มที่"
  },
  on_leave: {
    label: "วันลา",
    badge: "ลาป่วย",
    bannerColor: "#0ea5e9",
    closing: "หากต้องการเปลี่ยนแปลงข้อมูล ติดต่อหัวหน้าโดยตรงครับ",
    body: "บันทึกการลาของพี่: ลาป่วย"
  }
};

function ShiftReminderEditor({
  initial
}: {
  initial: Record<ShiftKind, string>;
}) {
  const router = useRouter();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // 'tab' switches which kind is being edited + previewed. Stacking
  // 3 full editors vertically would make the page feel busy; the
  // tabbed layout keeps the page short while still letting admin
  // edit every kind.
  const [activeKind, setActiveKind] = useState<ShiftKind>("work");
  const dirty =
    text.work !== initial.work ||
    text.day_off !== initial.day_off ||
    text.on_leave !== initial.on_leave;

  // Pick the first non-empty line of the override (or the first
  // default) for the preview greeting so admin sees an actual line
  // — not the empty string. {NAME} → sample nickname so the preview
  // shape matches what staff receive.
  const SAMPLE_NICK = "ตูน";
  function previewGreeting(kind: ShiftKind): string {
    const override = (text[kind] ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const pool = override.length > 0 ? override : (DEFAULT_SHIFT_GREETINGS[kind] as readonly string[]);
    return (pool[0] ?? "").replace(/\{NAME\}/g, SAMPLE_NICK);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/notifications"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shift_greetings_work: text.work,
          shift_greetings_day_off: text.day_off,
          shift_greetings_on_leave: text.on_leave
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message || j.error || "บันทึกไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: "บันทึกแล้ว · การแจ้งเตือนรอบถัดไปจะใช้คำทักทายใหม่" });
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: "เกิดข้อผิดพลาดเครือข่าย" });
    } finally {
      setBusy(false);
    }
  }

  const meta = KIND_META[activeKind];
  const placeholder = DEFAULT_SHIFT_GREETINGS[activeKind].join("\n");
  const lineCount = (text[activeKind] ?? "").split(/\r?\n/).filter((l) => l.trim().length > 0).length;

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-bold text-slate-800 text-base">
          การ์ดเตือนเวรประจำวัน
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          ส่งให้พนักงานทุกเช้าก่อนเริ่มเวร — น้องฮูกจะสุ่มเลือก 1 คำทักทายจากในรายการนี้ (เลือกซ้ำสำหรับวันเดียวกันเสมอ)
        </p>
      </div>

      {/* Kind tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {(Object.keys(KIND_META) as ShiftKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setActiveKind(k)}
            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition ${
              activeKind === k
                ? "border-brand text-brand"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {KIND_META[k].label}
            {text[k].trim() && (
              <span className="ml-1 text-[9px] text-emerald-600">●</span>
            )}
          </button>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Editor */}
        <div className="space-y-3">
          <div>
            <label className="label">รายการคำทักทาย ({lineCount} บรรทัด)</label>
            <p className="text-[10px] text-slate-500 mb-1.5">
              บรรทัดละ 1 คำทักทาย · ใช้ <code className="text-[10px] bg-slate-100 px-1 rounded">{"{NAME}"}</code>{" "}
              แทนชื่อเล่นพนักงาน (ติดกับ &quot;พี่&quot; ไม่ต้องเว้นวรรค) · เว้นว่างทั้งหมด = ใช้ชุดเริ่มต้นด้านล่าง
            </p>
            <textarea
              className="input font-mono text-[13px]"
              rows={8}
              maxLength={4000}
              value={text[activeKind]}
              onChange={(e) => setText({ ...text, [activeKind]: e.target.value })}
              placeholder={placeholder}
            />
            <p className="text-[10px] text-slate-400 text-right">
              {(text[activeKind] ?? "").length} / 4000
            </p>
          </div>

          {msg && (
            <div className={`text-sm text-center ${
              msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
            }`}>
              {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
            </div>
          )}

          <button type="button"
            onClick={save}
            disabled={busy || !dirty}
            className="btn-primary w-full text-sm py-2.5">
            {busy ? "กำลังบันทึก…" : dirty ? "บันทึกทุกแท็บ" : "ไม่มีการเปลี่ยนแปลง"}
          </button>
        </div>

        {/* Preview — uses the same green-banner shape as the real card */}
        <div>
          <div className="text-[10px] uppercase tracking-[0.5px] font-bold text-slate-500 mb-2">
            พรีวิว — {meta.label}
          </div>
          <FlexPreview
            header={{
              leftLabel: "IKIGAI OS · PERSONA",
              rightLabel: "ทักทายจากน้องฮูก",
              title: "เวรประจำวันของพี่"
            }}
            body={[
              { text: previewGreeting(activeKind) || "(ว่าง — ยังไม่มีคำทักทาย)", weight: "bold" },
              { divider: true },
              {
                text: meta.badge,
                weight: "bold",
                color: "dark",
                size: "md"
              },
              { text: meta.body, color: "muted" },
              { divider: true },
              { text: meta.closing, color: "muted", size: "xs" }
            ]}
          />
        </div>
      </div>
    </div>
  );
}

// ── Template 2: Resignation unlock ─────────────────────────────────

function ResignationUnlockEditor({ initial }: { initial: string }) {
  const router = useRouter();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const dirty = text !== initial;

  // Substitute {ADMIN} with a placeholder for the preview so admin
  // sees the real shape, not the literal token. Use a generic name
  // since the preview doesn't know who'll actually press the button.
  const SAMPLE_ADMIN = "แอดมิน A";
  const previewBody = (text.trim() || DEFAULT_UNLOCK_BODY)
    .replace(/\{ADMIN\}/g, SAMPLE_ADMIN);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(
        apiUrl("/api/admin/persona/resignation/settings"),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resignation_unlock_message: text })
        }
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message || j.error || "บันทึกไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: "บันทึกแล้ว · ครั้งต่อไปที่เปิดสิทธิ์ลาออก ระบบจะใช้ข้อความใหม่" });
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: "เกิดข้อผิดพลาดเครือข่าย" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-bold text-slate-800 text-base">
          การ์ดเปิดสิทธิ์ลาออก
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          ส่งให้พนักงานทาง LINE เมื่อแอดมินกด &quot;เปิดสิทธิ์ลาออก&quot; ที่หน้า
          {" "}<code className="text-[10px] bg-slate-100 px-1 rounded">/admin/persona/resignation</code>
        </p>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Editor */}
        <div className="space-y-3">
          <div>
            <label className="label">ข้อความบนการ์ด</label>
            <p className="text-[10px] text-slate-500 mb-1.5">
              ใช้ <code className="text-[10px] bg-slate-100 px-1 rounded">{"{ADMIN}"}</code> แทนชื่อแอดมินที่กดเปิด · เว้นว่าง = ใช้ข้อความเริ่มต้น
            </p>
            <textarea
              className="input"
              rows={6}
              maxLength={1000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={DEFAULT_UNLOCK_BODY}
            />
            <p className="text-[10px] text-slate-400 text-right">{text.length} / 1000</p>
          </div>

          {msg && (
            <div className={`text-sm text-center ${
              msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
            }`}>
              {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
            </div>
          )}

          <button type="button"
            onClick={save}
            disabled={busy || !dirty}
            className="btn-primary w-full text-sm py-2.5">
            {busy ? "กำลังบันทึก…" : dirty ? "บันทึก" : "ไม่มีการเปลี่ยนแปลง"}
          </button>
        </div>

        {/* Preview */}
        <div>
          <div className="text-[10px] uppercase tracking-[0.5px] font-bold text-slate-500 mb-2">
            พรีวิว (จำลอง LINE Flex)
          </div>
          <FlexPreview
            header={{
              leftLabel: "IKIGAI OS · PERSONA",
              rightLabel: "ทักทายจากน้องฮูก",
              title: "เปิดสิทธิ์ยื่นลาออกแล้ว"
            }}
            body={[
              { text: "สวัสดีครับพี่ตูน", weight: "bold" },
              { text: previewBody, color: "dark" },
              { divider: true },
              {
                text: "หากเปลี่ยนใจไม่ต้องการยื่น ก็ไม่ต้องทำอะไรครับ สิทธิ์นี้จะอยู่จนกว่าพี่จะกรอกหรือแอดมินจะปิดอีกครั้ง",
                color: "muted",
                size: "xs"
              }
            ]}
            buttonLabel="เปิดแบบฟอร์มยื่นลาออก"
          />
        </div>
      </div>
    </div>
  );
}
