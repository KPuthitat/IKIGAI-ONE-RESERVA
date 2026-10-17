"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiUrl } from "@/lib/url";
import { FormSection, Field } from "@/app/components/FormKit";
import Switch from "@/app/components/Switch";

type Position = { id: number; slotNo: number; name: string; description: string | null; dailyRate: number; eligibleGroups: string[] | null; active: boolean };
type Data = {
  isOwner: boolean; config: Record<string, number> | null; branches: Array<{ id: number; name: string }>; branchId: number;
  month: { enabled: boolean; status: string; bookingCloseDate: string | null }; positions: Position[]; workGroups: string[];
};

const MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const GROUP_TH: Record<string, string> = { service: "บริการ", kitchen: "ครัว", management: "บริหาร", other: "อื่นๆ" };
const STATUS_TH: Record<string, string> = {
  off: "ยังไม่เปิดใช้", awaiting_roster: "รอประกาศตารางงานประจำเดือน", booking_open: "เปิดให้พนักงานเลือกวัน", booking_closed: "ปิดรับการเลือกวันแล้ว",
  filling: "กำลังจัดวันที่ว่าง", special_published: "ประกาศตารางแล้ว", in_progress: "อยู่ระหว่างปฏิบัติงาน", settled: "ปิดรอบแล้ว"
};
const CONFIG_LABEL: Record<string, string> = {
  max_positions_per_branch: "จำนวนตำแหน่งสูงสุดต่อสาขา (ไม่เกิน 3)",
  default_daily_rate: "ค่าตอบแทนต่อวันเริ่มต้น (บาท)",
  min_days_per_position: "จำนวนวันขั้นต่ำที่ต้องเลือกต่อหนึ่งตำแหน่ง",
  max_positions_per_person_per_day: "จำนวนตำแหน่งสูงสุดที่คนเดียวทำได้ในหนึ่งวัน",
  absence_strike_limit: "จำนวนครั้งที่ขาดได้ก่อนเสียสิทธิ์เลือกวันเองในเดือนถัดไป",
  booking_close_day_of_previous_month: "วันที่ปิดรับการเลือกวัน (ของเดือนก่อนหน้า)",
  min_booking_window_days: "จำนวนวันขั้นต่ำที่เปิดให้เลือกหลังประกาศตาราง",
  evidence_min_photos: "จำนวนภาพหลักฐานขั้นต่ำ",
  evidence_max_photos: "จำนวนภาพหลักฐานสูงสุด",
  evidence_deadline_days: "ส่งหลักฐานได้ภายในกี่วันหลังวันปฏิบัติงาน",
  evidence_retention_days: "เก็บภาพหลักฐานกี่วันก่อนลบอัตโนมัติ",
  swap_notice_days: "แจ้งสลับวันล่วงหน้าอย่างน้อยกี่วัน",
  owner_alert_min_bookers: "เตือนเจ้าของเมื่อผู้ได้รับตำแหน่งน้อยกว่ากี่คน",
  owner_alert_max_days_per_person: "เตือนเจ้าของเมื่อมีคนได้ตำแหน่งเกินกี่วันต่อเดือน"
};
const ERR_TH: Record<string, string> = {
  month_in_past: "ไม่สามารถเปิดใช้เดือนที่ผ่านมาแล้ว", has_bookings: "ปิดใช้เดือนนี้ไม่ได้ เพราะมีการเลือกหรือมอบหมายวันแล้ว", month_settled: "เดือนนี้ปิดรอบแล้ว",
  positions_locked: "แก้ตำแหน่งไม่ได้แล้ว เพราะเปิดให้เลือกวันแล้ว (พนักงานเห็นค่าตอบแทนไปแล้ว)", invalid_group: "กลุ่มงานไม่ถูกต้อง", invalid_rate: "ค่าตอบแทนไม่ถูกต้อง",
  name_required: "กรุณาใส่ชื่อตำแหน่ง", max_positions_capped: "ระบบรองรับสูงสุด 3 ตำแหน่งต่อสาขา", invalid_value: "ค่าที่ใส่ไม่ถูกต้อง", forbidden: "ไม่มีสิทธิ์ทำรายการนี้"
};
const shift = (ym: string, by: number) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7); };

export default function Client({ month, branch }: { month: string; branch: number | null }) {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, { name: string; description: string; rate: string; groups: string[] | null; active: boolean }>>({});
  const [cfg, setCfg] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const r = await fetch(apiUrl(`/api/admin/persona/special-duty/settings?month=${month}${branch ? `&branch=${branch}` : ""}`), { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) { setMsg({ ok: false, text: ERR_TH[j.error] ?? "ไม่สามารถแสดงข้อมูลได้" }); return; }
    setData(j);
    const d: typeof drafts = {};
    for (const slot of [1, 2, 3]) {
      const p = (j as Data).positions.find((x) => x.slotNo === slot);
      d[slot] = { name: p?.name ?? "", description: p?.description ?? "", rate: String(p?.dailyRate ?? j.config?.default_daily_rate ?? 150), groups: p?.eligibleGroups ?? null, active: p?.active ?? true };
    }
    setDrafts(d);
    if (j.config) setCfg(Object.fromEntries(Object.entries(j.config as Record<string, number>).map(([k, v]) => [k, String(v)])));
  }, [month, branch]);
  useEffect(() => { load(); }, [load]);

  async function post(body: Record<string, unknown>, okText: string) {
    setBusy(true); setMsg(null);
    const r = await fetch(apiUrl("/api/admin/persona/special-duty/settings"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: ERR_TH[j.error] ?? j.detail ?? "ทำรายการไม่สำเร็จ" }); return false; }
    setMsg({ ok: true, text: okText }); await load(); router.refresh(); return true;
  }

  if (!data) return <div className="card text-sm text-slate-500">{msg?.text ?? "กำลังโหลด"}</div>;
  const [y, m] = month.split("-").map(Number);
  const editable = ["off", "awaiting_roster"].includes(data.month.status);
  const go = (_b: number, mo: string) => router.push(`?month=${mo}`);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">ตั้งค่าตำแหน่งงานค่าตอบแทนพิเศษ</h1>
          <p className="text-sm text-slate-500 mt-1">เปิดใช้รายเดือนของแต่ละสาขา กำหนดตำแหน่ง ค่าตอบแทน และกลุ่มงานที่ทำได้</p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href={`/admin/persona/special-duty?month=${month}`} className="btn-secondary !py-1.5">หน้าผู้จัดการ</Link>
          <Link href={`/admin/persona/special-duty/overview?month=${month}`} className="btn-secondary !py-1.5">ภาพรวมทุกสาขา</Link>
        </div>
      </div>
      {msg && <div className={`card text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</div>}

      <section className="card space-y-3">
        <div className="grid sm:grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-[var(--card-border)] bg-[var(--surface-field)] px-3 py-2 leading-tight">
            <div className="text-[11.5px] font-medium text-slate-500">สาขา (ตามสาขาที่เลือกอยู่ด้านบน)</div>
            <div className="font-bold text-slate-800">{data.branches.find((b) => b.id === data.branchId)?.name ?? ""}</div>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--card-border)] bg-[var(--surface-field)] px-3 py-2">
            <button type="button" className="chip" onClick={() => go(data.branchId, shift(month, -1))} aria-label="เดือนก่อน">‹ ก่อน</button>
            <div className="text-center leading-tight">
              <div className="text-[11.5px] font-medium text-slate-500">เดือน</div>
              <div className="font-bold text-slate-800 whitespace-nowrap">{MONTHS[m - 1]} {y + 543}</div>
            </div>
            <button type="button" className="chip" onClick={() => go(data.branchId, shift(month, 1))} aria-label="เดือนถัดไป">ถัดไป ›</button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-sm"><span className="text-slate-500">สถานะ</span> <span className={`tag ${data.month.enabled ? "tag-ok" : "tag-mute"}`}>{STATUS_TH[data.month.status] ?? data.month.status}</span></div>
          {!data.month.enabled
            ? <button type="button" className="btn-primary" disabled={busy || data.positions.length === 0} onClick={() => window.confirm("เปิดใช้ตำแหน่งงานค่าตอบแทนพิเศษของสาขานี้ในเดือนนี้ใช่หรือไม่ เมื่อประกาศตารางงานระบบจะเปิดให้พนักงานเลือกวันและแจ้งผ่าน LINE") && post({ action: "enable_month", branch_id: data.branchId, month }, "เปิดใช้เดือนนี้เรียบร้อยแล้ว")}>เปิดใช้เดือนนี้</button>
            : <button type="button" className="btn-secondary" disabled={busy} onClick={() => window.confirm("ปิดใช้เดือนนี้ใช่หรือไม่ (ทำได้เฉพาะเมื่อยังไม่มีการเลือกหรือมอบหมายวัน)") && post({ action: "disable_month", branch_id: data.branchId, month }, "ปิดใช้เดือนนี้แล้ว")}>ปิดใช้เดือนนี้</button>}
        </div>
        {!data.month.enabled && data.positions.length === 0 && <p className="text-xs text-slate-500">กำหนดอย่างน้อยหนึ่งตำแหน่งด้านล่างก่อนเปิดใช้ ถ้าเดือนก่อนหน้ามีตำแหน่งอยู่แล้ว ระบบคัดลอกให้ตอนเปิดใช้</p>}
      </section>

      <section className="space-y-3">
        <h2 className="font-bold text-slate-800">ตำแหน่งของเดือนนี้ <span className="text-sm font-normal text-slate-500">(ไม่เกิน 3 ตำแหน่ง)</span></h2>
        {!editable && <p className="card text-sm text-amber-800 bg-amber-50 border-amber-200">แก้ตำแหน่งไม่ได้แล้ว เพราะเปิดให้พนักงานเลือกวันแล้ว เพื่อไม่ให้ค่าตอบแทนที่พนักงานเห็นและตกลงไว้เปลี่ยนไป</p>}
        <div className="grid lg:grid-cols-3 gap-3 items-start">
        {[1, 2, 3].map((slot) => {
          const dr = drafts[slot]; if (!dr) return null;
          const set = (patch: Partial<typeof dr>) => setDrafts((s) => ({ ...s, [slot]: { ...s[slot], ...patch } }));
          return (
            <div key={slot} className={`card ${dr.active ? "" : "opacity-70"}`}>
              <FormSection title={`ตำแหน่งที่ ${slot}`}
                action={<span className="inline-flex items-center gap-1.5 text-xs text-slate-500"><Switch checked={dr.active} onChange={(v) => editable && set({ active: v })} />{dr.active ? "เปิดใช้" : "ปิด"}</span>}>
                <Field label="ชื่อตำแหน่ง"><input disabled={!editable} placeholder="เช่น ล้างห้องน้ำ" value={dr.name} onChange={(e) => set({ name: e.target.value })} /></Field>
                <Field label="รายละเอียดงาน" hint="ไม่บังคับ"><input disabled={!editable} value={dr.description} onChange={(e) => set({ description: e.target.value })} /></Field>
                <Field label="ค่าตอบแทนต่อวัน (บาท)"><input type="number" min="0" disabled={!editable} value={dr.rate} onChange={(e) => set({ rate: e.target.value })} /></Field>
                <div>
                  <div className="text-xs text-slate-500 mb-1.5">กลุ่มงานที่ทำได้ <span className="text-slate-400">(ไม่เลือกเลย = ทุกกลุ่ม)</span></div>
                  <div className="flex flex-wrap gap-1.5">
                    {data.workGroups.map((g) => {
                      const on = !!dr.groups?.includes(g);
                      return (
                        <button key={g} type="button" disabled={!editable} aria-pressed={on} className={`chip ${on ? "chip-active" : ""} disabled:opacity-60`}
                          onClick={() => { const cur = new Set(dr.groups ?? []); if (on) cur.delete(g); else cur.add(g); set({ groups: cur.size ? [...cur] : null }); }}>
                          {GROUP_TH[g] ?? g}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {editable && <button type="button" className="btn-primary w-full" disabled={busy || !dr.name.trim()} onClick={() => post({ action: "save_position", branch_id: data.branchId, month, slot_no: slot, name: dr.name, description: dr.description || null, daily_rate: Number(dr.rate), eligible_groups: dr.groups, active: dr.active }, `บันทึกตำแหน่งที่ ${slot} แล้ว`)}>บันทึกตำแหน่งที่ {slot}</button>}
              </FormSection>
            </div>
          );
        })}
        </div>
      </section>

      {data.isOwner && data.config && (
        <section className="card space-y-3">
          <h2 className="font-bold text-slate-800">เกณฑ์ของระบบ <span className="text-sm font-normal text-slate-500">(เฉพาะเจ้าของ)</span></h2>
          <p className="text-sm text-slate-500">ค่าเหล่านี้ใช้กับทุกสาขา การเปลี่ยนมีผลกับการคำนวณต่อจากนี้ และบันทึกประวัติไว้</p>
          {Object.keys(data.config).map((k) => (
            <div key={k} className="flex items-center justify-between gap-3 border-t border-[color:var(--card-border)] pt-2.5 first:border-0 first:pt-0">
              <label className="text-sm text-slate-700 flex-1" htmlFor={`cfg-${k}`}>{CONFIG_LABEL[k] ?? k}</label>
              <input id={`cfg-${k}`} type="number" min="0" className="input !w-24 !py-1.5 text-right" value={cfg[k] ?? ""} onChange={(e) => setCfg((s) => ({ ...s, [k]: e.target.value }))} />
              <button type="button" className="btn-secondary !py-1.5 !px-4" disabled={busy || cfg[k] === String(data.config![k]) || cfg[k] === ""} onClick={() => post({ action: "set_config", key: k, value: Number(cfg[k]) }, "บันทึกเกณฑ์แล้ว")}>บันทึก</button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
