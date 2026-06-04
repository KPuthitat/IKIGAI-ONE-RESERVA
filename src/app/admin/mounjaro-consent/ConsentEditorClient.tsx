"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

export default function ConsentEditorClient({
  initialBody, version
}: {
  initialBody: string;
  version: string | null;
}) {
  const router = useRouter();
  const [body, setBody] = useState(initialBody);
  const [asNew, setAsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const dirty = body.trim() !== initialBody.trim();

  async function save() {
    if (body.trim().length < 20) {
      setMsg({ kind: "err", text: "ข้อความสั้นเกินไป" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/mounjaro/consent"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: body.trim(), new_version: asNew })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: "บันทึกไม่สำเร็จ" });
        return;
      }
      setMsg({
        kind: "ok",
        text: asNew
          ? `✓ เผยแพร่เวอร์ชันใหม่ (${j.version}) — พนักงานที่อยู่ในโครงการจะถูกขอความยินยอมใหม่`
          : "✓ บันทึกข้อความแล้ว"
      });
      setAsNew(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <div>
        <label className="label">ข้อความความยินยอม</label>
        <textarea
          className="input text-sm leading-relaxed"
          rows={16}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="ข้าพเจ้ายินยอมเข้าร่วมโครงการ…"
        />
        <p className="text-[11px] text-slate-400 mt-1">
          ขึ้นบรรทัดใหม่ได้ตามปกติ · ใช้ • นำหน้าเพื่อทำเป็นหัวข้อย่อย (แสดงผลตามที่พิมพ์)
        </p>
      </div>

      <label className="flex items-start gap-2 text-sm text-slate-700 p-3 rounded-lg border border-amber-200 bg-amber-50">
        <input type="checkbox" className="mt-0.5" checked={asNew} onChange={(e) => setAsNew(e.target.checked)} />
        <span>
          <b>เผยแพร่เป็นเวอร์ชันใหม่</b> (แนะนำเมื่อแก้สาระสำคัญ)
          <span className="block text-[11px] text-amber-700 mt-0.5">
            พนักงานที่อยู่ในโครงการทุกคนจะถูกขอ<b>กดยินยอมใหม่</b>ครั้งถัดไปที่เปิดหน้า
            · ถ้าแค่แก้คำผิด/จัดรูปแบบ ไม่ต้องติ๊ก (ใช้เวอร์ชันเดิม {version ?? "—"})
          </span>
        </span>
      </label>

      {msg && (
        <p className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>
      )}

      <button
        type="button"
        onClick={save}
        disabled={busy || (!dirty && !asNew)}
        className="btn-primary py-2.5 disabled:opacity-50"
      >
        {busy ? "กำลังบันทึก…" : asNew ? "เผยแพร่เวอร์ชันใหม่" : "บันทึกข้อความ"}
      </button>
    </div>
  );
}
