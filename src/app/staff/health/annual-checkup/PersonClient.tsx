"use client";

import { useState } from "react";
import { glueParen } from "@/lib/text";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Banner, INTERP, INTERP_TH, STATUS_CLS, STATUS_TH, post, upload } from "./shared";

export type PersonRow = {
  order_id: number; order_status: "ordered" | "waived" | "external_lab"; code: string; name_th: string; test_unit: string | null; value_kind: string;
  waive_reason: string | null; external_lab_name: string | null;
  result_id: number | null; revision: number | null; result_status: "draft" | "verified" | "released" | null;
  value_num: number | null; value_text: string | null; unit: string | null; ref_text: string | null; interpretation: "normal" | "abnormal" | "follow_up" | null;
  has_file: number; verified_at: string | null; released_at: string | null;
  fileHref: string | null; defaultRef: string;
};

export default function PersonClient({ rows, roundId, subject, externalId, needsName, isApprover, unlocked }: {
  rows: PersonRow[]; roundId: number; subject: string; externalId: number | null; needsName: boolean; isApprover: boolean; unlocked: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const done = (ok: boolean, text: string) => { setMsg({ ok, text }); if (ok) router.refresh(); };
  const doctor = isApprover && unlocked;

  return (
    <div className="space-y-4">
      <Banner msg={msg} />
      {externalId != null && needsName && <NameForm externalId={externalId} onDone={done} />}
      <div className="space-y-3">
        {rows.map((r) => <TestRow key={r.order_id} r={r} doctor={doctor} isApprover={isApprover} entryHref={`/staff/health/annual-checkup/${roundId}/person/${subject}/entry`} onDone={done} />)}
      </div>
    </div>
  );
}

function NameForm({ externalId, onDone }: { externalId: number; onDone: (ok: boolean, t: string) => void }) {
  const [name, setName] = useState(""); const [sex, setSex] = useState(""); const [dob, setDob] = useState(""); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); const r = await post("external", { externalId, fullName: name, sex: sex || null, dob: dob || null }); setBusy(false); onDone(!!r.ok, r.ok ? "บันทึกชื่อแล้ว" : r.message ?? "บันทึกไม่สำเร็จ"); };
  return (
    <div className="card space-y-2">
      <div className="text-sm font-semibold text-slate-800">ใส่ชื่อผู้เข้าตรวจ (ยังเป็น “รอเพิ่มรายชื่อ”)</div>
      <div className="grid gap-2 sm:grid-cols-3">
        <input className="input" placeholder="ชื่อ-นามสกุล (รวมคำนำหน้า)" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="input" value={sex} onChange={(e) => setSex(e.target.value)}><option value="">เพศ (ไม่ระบุ)</option><option value="M">ชาย</option><option value="F">หญิง</option></select>
        <input type="date" className="input" value={dob} onChange={(e) => setDob(e.target.value)} />
      </div>
      <button type="button" className="btn-primary" disabled={busy || !name.trim()} onClick={save}>บันทึกชื่อ</button>
    </div>
  );
}

function TestRow({ r, doctor, isApprover, entryHref, onDone }: { r: PersonRow; doctor: boolean; isApprover: boolean; entryHref: string; onDone: (ok: boolean, t: string) => void }) {
  const isNum = r.value_kind === "number";
  const [value, setValue] = useState(isNum ? (r.value_num != null ? String(r.value_num) : "") : r.value_text ?? "");
  const [unit, setUnit] = useState(r.unit ?? r.test_unit ?? "");
  const [ref, setRef] = useState(r.ref_text ?? r.defaultRef);
  const [interp, setInterp] = useState<string>(r.interpretation ?? "");
  const [reason, setReason] = useState(r.waive_reason ?? "");
  const [lab, setLab] = useState(r.external_lab_name ?? "");
  const [revising, setRevising] = useState(false);
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = r.result_status === "verified" || r.result_status === "released";

  const fields = () => ({
    valueNum: isNum ? (value.trim() === "" ? null : Number(value)) : null,
    valueText: isNum ? null : value.trim() || null, unit: unit.trim() || null, refText: ref.trim() || null, interpretation: (interp || null) as "normal" | "abnormal" | "follow_up" | null
  });
  const run = async (fn: () => Promise<{ ok: boolean; message?: string }>, okText: string) => { setBusy(true); const x = await fn(); setBusy(false); onDone(!!x.ok, x.ok ? okText : x.message ?? "ทำรายการไม่สำเร็จ"); return x.ok; };

  const save = () => { if (isNum && value.trim() !== "" && !Number.isFinite(Number(value))) { onDone(false, `ค่าของ “${r.name_th}” ต้องเป็นตัวเลข`); return; } return run(() => post("result", { orderId: r.order_id, ...fields() }), `บันทึก “${r.name_th}” แล้ว`); };
  const attach = async (f: File | undefined) => { if (f) await run(() => upload(r.order_id, f), "แนบไฟล์แล้ว"); };
  const revise = async () => { if (await run(() => post("revise", { resultId: r.result_id, reason: why, ...fields() }), `ทำฉบับแก้ไขของ “${r.name_th}” แล้ว (กลับเป็นร่าง ต้องตรวจสอบใหม่)`)) setRevising(false); };
  const saveClinical = () => run(() => post("clinical", { orderId: r.order_id, waiveReason: r.order_status === "waived" ? reason : null, externalLabName: r.order_status === "external_lab" ? lab : null }), "บันทึกแล้ว");

  const badge = r.order_status === "waived" ? <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">งดตรวจ</span>
    : r.order_status === "external_lab" ? <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] text-violet-700">แล็บนอก</span> : null;

  // values are typed in ONE place (the booklet tabs); an ordinary test is a summary line here with a link there.
  // This screen keeps what only it does: why a test is waived, the outside lab's name + file, and revising a verified result.
  if (!locked && r.order_status === "ordered") {
    const shown = r.value_num != null ? String(r.value_num) : r.value_text ?? (r.has_file ? "ไฟล์แนบ" : r.result_id ? "หลายรายการ" : "—");
    return (
      <div className="card !py-3 flex items-center gap-3">
        <div className="min-w-0 flex-1"><div className="font-medium text-slate-800 break-words">{glueParen(r.name_th)}</div><div className="text-xs text-slate-500">{r.result_status ? "ร่าง ยังไม่ตรวจสอบ" : "ยังไม่ลงผล"}</div></div>
        <div className="text-right shrink-0"><div className="font-bold text-slate-900 whitespace-pre-line">{shown}</div><div className="text-[11px] text-slate-500">{r.unit ?? r.test_unit ?? ""}</div></div>
        <Link href={entryHref} className="btn-secondary text-xs min-h-[44px] px-3 shrink-0 inline-flex items-center">{r.result_status ? "แก้ไข" : "กรอกผล"}</Link>
      </div>
    );
  }

  // a verified / released result is shown as one read-only line; the form opens only when someone needs to revise it
  if (locked && !open) {
    const shown = r.value_num != null ? String(r.value_num) : r.value_text ?? (r.has_file ? "ไฟล์แนบ" : "หลายรายการ");
    return (
      <div className="card !py-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-800 break-words">{glueParen(r.name_th)}</div>
          <div className="text-xs text-slate-500">{r.ref_text ? `อ้างอิง ${r.ref_text} · ` : ""}{r.result_status ? STATUS_TH[r.result_status] : ""}{r.revision && r.revision > 1 ? ` · ฉบับที่ ${r.revision}` : ""}{r.interpretation ? ` · ${INTERP_TH[r.interpretation]}` : ""}</div>
        </div>
        <div className="text-right shrink-0"><div className="font-bold text-slate-900 whitespace-pre-line">{shown}</div><div className="text-[11px] text-slate-500">{r.unit ?? r.test_unit ?? ""}</div></div>
        <button type="button" className="btn-secondary text-xs min-h-[44px] px-3 shrink-0" onClick={() => setOpen(true)} aria-label={`รายละเอียด ${r.name_th}`}>รายละเอียด</button>
      </div>
    );
  }

  return (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="font-medium text-slate-800">{glueParen(r.name_th)}</div>
        {locked && <button type="button" className="ml-auto text-xs underline text-slate-500 min-h-[44px]" onClick={() => setOpen(false)}>ย่อ</button>}
        {badge}
        {r.result_status && <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_CLS[r.result_status]}`}>{STATUS_TH[r.result_status]}{r.revision && r.revision > 1 ? ` · ฉบับที่ ${r.revision}` : ""}</span>}
        {!r.result_status && r.order_status !== "waived" && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">ยังไม่ลงผล</span>}
      </div>

      {r.order_status === "waived" ? (
        <div className="space-y-1">
          <label className="block text-xs text-slate-500">เหตุผลที่งดตรวจ (ข้อมูลทางการแพทย์ — เห็นเฉพาะเจ้าหน้าที่คลินิก ไม่แสดงให้ HR / ผู้จัดการ / พนักงาน)</label>
          <textarea className="input w-full" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn-secondary" disabled={busy} onClick={saveClinical}>บันทึกเหตุผล</button>
        </div>
      ) : (
        <>
          {r.order_status === "external_lab" && (
            <div className="grid gap-2 sm:grid-cols-2">
              <input className="input" placeholder="ชื่อแล็บภายนอก" value={lab} onChange={(e) => setLab(e.target.value)} />
              <button type="button" className="btn-secondary" disabled={busy} onClick={saveClinical}>บันทึกชื่อแล็บ</button>
              {!r.has_file && <div className="text-xs text-violet-700 sm:col-span-2">ต้องแนบไฟล์ผลจากแล็บภายนอกก่อนจึงลงผลได้</div>}
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-12">
            {r.value_kind === "number"
              ? <input className="input sm:col-span-3" inputMode="decimal" placeholder="ค่า" value={value} disabled={locked} onChange={(e) => setValue(e.target.value)} />
              : <textarea className="input sm:col-span-6" rows={r.value_kind === "panel" ? 3 : 1} placeholder="ผล / ค่า" value={value} disabled={locked} onChange={(e) => setValue(e.target.value)} />}
            <input className="input sm:col-span-2" placeholder="หน่วย" value={unit} disabled={locked} onChange={(e) => setUnit(e.target.value)} />
            <input className="input sm:col-span-3" placeholder="ค่าอ้างอิง" value={ref} disabled={locked} onChange={(e) => setRef(e.target.value)} />
            <select className="input sm:col-span-2" value={interp} disabled={locked} onChange={(e) => setInterp(e.target.value)}>
              <option value="">ผลแปล</option>{INTERP.map((o) => <option key={o.v} value={o.v}>{o.th}</option>)}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!locked && <button type="button" className="btn-primary" disabled={busy} onClick={save}>บันทึกร่าง</button>}
            {!locked && (
              <label className="btn-secondary cursor-pointer">
                แนบไฟล์ผลแล็บ (PDF / รูป)
                <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { attach(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
            )}
            {r.fileHref && <a className="text-sm text-brand underline" href={r.fileHref} target="_blank" rel="noreferrer">ดูไฟล์ที่แนบ</a>}
            {locked && isApprover && !revising && <button type="button" className="btn-secondary" disabled={!doctor} title={doctor ? "" : "ปลดล็อกด้วยเลขใบประกอบก่อน"} onClick={() => setRevising(true)}>ทำฉบับแก้ไข</button>}
          </div>
          {r.interpretation && locked && <div className="text-xs text-slate-500">ผลแปล: {INTERP_TH[r.interpretation]}</div>}
          {revising && (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="text-sm font-semibold text-amber-900">ฉบับแก้ไข — แก้ค่าด้านบน แล้วระบุเหตุผล ผลจะกลับเป็นร่างและซ่อนจากพนักงานจนกว่าจะตรวจสอบและเปิดผลใหม่ ฉบับเดิมเก็บไว้ในประวัติ</div>
              <p className="text-xs text-amber-800">ช่องค่าด้านบนถูกล็อกอยู่ ให้พิมพ์ค่าที่ถูกต้องในช่องนี้</p>
              <div className="grid gap-2 sm:grid-cols-12">
                <input className="input sm:col-span-4" placeholder="ค่าใหม่" value={value} onChange={(e) => setValue(e.target.value)} />
                <input className="input sm:col-span-2" placeholder="หน่วย" value={unit} onChange={(e) => setUnit(e.target.value)} />
                <input className="input sm:col-span-3" placeholder="ค่าอ้างอิง" value={ref} onChange={(e) => setRef(e.target.value)} />
                <select className="input sm:col-span-3" value={interp} onChange={(e) => setInterp(e.target.value)}><option value="">ผลแปล</option>{INTERP.map((o) => <option key={o.v} value={o.v}>{o.th}</option>)}</select>
              </div>
              <input className="input w-full" placeholder="เหตุผลที่แก้ไข (บังคับ)" value={why} onChange={(e) => setWhy(e.target.value)} />
              <div className="flex gap-2">
                <button type="button" className="btn-primary" disabled={busy || !why.trim()} onClick={revise}>บันทึกฉบับแก้ไข</button>
                <button type="button" className="btn-secondary" onClick={() => setRevising(false)}>ยกเลิก</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
