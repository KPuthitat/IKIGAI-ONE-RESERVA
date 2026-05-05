"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Branch } from "@/lib/db";
import { apiUrl } from "@/lib/url";

export default function SettingsClient({ branch }: { branch: Branch }) {
  const router = useRouter();
  const [form, setForm] = useState({
    open_time: branch.open_time,
    close_time: branch.close_time,
    slot_minutes: branch.slot_minutes,
    default_duration_minutes: branch.default_duration_minutes,
    reminder_minutes_before: branch.reminder_minutes_before,
    line_channel_secret: branch.line_channel_secret ?? "",
    line_channel_token: branch.line_channel_token ?? "",
    staff_line_user_ids: branch.staff_line_user_ids ?? "[]"
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setOk(false);
    try {
      JSON.parse(form.staff_line_user_ids);
    } catch {
      setErr("staff_line_user_ids ต้องเป็น JSON array เช่น [\"U1234...\",\"U5678...\"]");
      return;
    }
    setBusy(true);
    const res = await fetch(apiUrl(`/api/admin/branch/${branch.id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error || "บันทึกไม่สำเร็จ");
      return;
    }
    setOk(true);
    router.refresh();
  }

  return (
    <form onSubmit={save} className="card space-y-4 max-w-2xl">
      <h2 className="font-semibold">เวลาเปิด-ปิด</h2>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">เปิด</label>
          <input type="time" className="input" value={form.open_time}
            onChange={(e) => setForm({ ...form, open_time: e.target.value })} />
        </div>
        <div>
          <label className="label">ปิด</label>
          <input type="time" className="input" value={form.close_time}
            onChange={(e) => setForm({ ...form, close_time: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">ช่วงเวลาจอง (นาที)</label>
          <input type="number" min={15} max={120} step={15} className="input"
            value={form.slot_minutes}
            onChange={(e) => setForm({ ...form, slot_minutes: Number(e.target.value) })} />
        </div>
        <div>
          <label className="label">ระยะเวลาต่อโต๊ะ (นาที)</label>
          <input type="number" min={30} max={240} step={15} className="input"
            value={form.default_duration_minutes}
            onChange={(e) => setForm({ ...form, default_duration_minutes: Number(e.target.value) })} />
        </div>
      </div>

      <h2 className="font-semibold pt-3 border-t border-slate-100">การแจ้งเตือน</h2>
      <div>
        <label className="label">แจ้งเตือนล่วงหน้าก่อนถึงเวลาจอง (นาที)</label>
        <input type="number" min={15} max={240} step={15} className="input"
          value={form.reminder_minutes_before}
          onChange={(e) => setForm({ ...form, reminder_minutes_before: Number(e.target.value) })} />
      </div>

      <h2 className="font-semibold pt-3 border-t border-slate-100">LINE Messaging API</h2>
      <p className="text-sm text-slate-500">
        สร้าง LINE Official Account → Provider/Channel ที่{" "}
        <a className="text-brand underline" href="https://developers.line.biz/console/" target="_blank" rel="noreferrer">
          LINE Developers Console
        </a> แล้วคัดลอก Channel Secret + Channel Access Token มาใส่ที่นี่
      </p>
      <div>
        <label className="label">Channel Access Token (long-lived)</label>
        <input className="input font-mono text-xs" value={form.line_channel_token}
          onChange={(e) => setForm({ ...form, line_channel_token: e.target.value })}
          placeholder="ใส่ token ยาวจาก LINE Developers" />
      </div>
      <div>
        <label className="label">Channel Secret</label>
        <input className="input font-mono text-xs" value={form.line_channel_secret}
          onChange={(e) => setForm({ ...form, line_channel_secret: e.target.value })} />
      </div>
      <div>
        <label className="label">LINE userId พนักงานที่จะรับแจ้งเตือน (JSON array)</label>
        <textarea className="input font-mono text-xs" rows={3}
          value={form.staff_line_user_ids}
          onChange={(e) => setForm({ ...form, staff_line_user_ids: e.target.value })}
          placeholder='["U1234abcd...","U5678efgh..."]' />
        <p className="text-xs text-slate-500 mt-1">
          ดู userId ได้จาก webhook log หรือใช้ LINE Developers ตอบกลับ profile API
        </p>
      </div>

      {err && <div className="text-red-600 text-sm">{err}</div>}
      {ok && <div className="text-emerald-600 text-sm">บันทึกเรียบร้อย</div>}
      <button className="btn-primary" disabled={busy}>{busy ? "กำลังบันทึก..." : "บันทึก"}</button>
    </form>
  );
}
