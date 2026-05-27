"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import FlexPreview from "./FlexPreview";

// Per-template editor + LINE-approximate preview. Today there's one
// template (resignation_unlock); the file is structured so the next
// templates land as their own <TemplateEditor /> block without
// scaffolding sprawl.

const DEFAULT_UNLOCK_BODY =
  "{ADMIN} เพิ่งเปิดสิทธิ์ยื่นใบลาออกให้พี่แล้วครับ — ถ้าพี่ต้องการยื่น สามารถเข้าไปกรอกแบบฟอร์มได้ที่ปุ่มด้านล่าง";

export default function NotificationsClient({
  resignationUnlockMessage
}: {
  resignationUnlockMessage: string;
}) {
  return (
    <div className="space-y-6">
      <ResignationUnlockEditor initial={resignationUnlockMessage} />

      <div className="card bg-slate-50 border-slate-200 text-[11px] text-slate-500 space-y-1">
        <div className="font-bold text-slate-600">การ์ดอื่นที่จะปรับแต่งได้ในเฟสถัดไป</div>
        <div>· การ์ดเตือนเวรประจำวัน (น้องฮูกทักทาย — ปัจจุบัน greeting หมุนตามวัน, ยังไม่ปรับเอง)</div>
        <div>· การ์ดแจ้งเตือนคำขอลา (submitted / approved / rejected / escalated)</div>
        <div>· การ์ดสรุปการเข้างานรายวัน (รายงานเข้ากลุ่มผู้บริหาร)</div>
      </div>
    </div>
  );
}

// ── Template 1: Resignation unlock ─────────────────────────────────

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
