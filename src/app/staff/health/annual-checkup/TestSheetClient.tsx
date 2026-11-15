"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Banner, INTERP, STATUS_CLS, STATUS_TH, post } from "./shared";

export type SheetRowView = {
  order_id: number; order_status: "ordered" | "waived" | "external_lab"; key: string; label: string; code: string | null; payer: string;
  result_id: number | null; result_status: "draft" | "verified" | "released" | null;
  value_num: number | null; value_text: string | null; unit: string | null; ref_text: string | null; interpretation: "normal" | "abnormal" | "follow_up" | null; has_file: boolean;
};
type Edit = { value: string; unit: string; ref: string; interp: string };

// One test for many people (e.g. hepatitis A for everyone): type the values down the column, save all the changed rows at once.
export default function TestSheetClient({ roundId, valueKind, defaultUnit, rows, isApprover, unlocked }: {
  roundId: number; valueKind: string; defaultUnit: string | null; rows: SheetRowView[]; isApprover: boolean; unlocked: boolean;
}) {
  const router = useRouter();
  const isNum = valueKind === "number";
  const initial = (r: SheetRowView): Edit => ({ value: isNum ? (r.value_num != null ? String(r.value_num) : "") : r.value_text ?? "", unit: r.unit ?? defaultUnit ?? "", ref: r.ref_text ?? "", interp: r.interpretation ?? "" });
  const [edits, setEdits] = useState<Record<number, Edit>>({});
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const get = (r: SheetRowView) => edits[r.order_id] ?? initial(r);
  const set = (r: SheetRowView, patch: Partial<Edit>) => setEdits((e) => ({ ...e, [r.order_id]: { ...get(r), ...patch } }));
  const editable = (r: SheetRowView) => r.order_status !== "waived" && r.result_status !== "verified" && r.result_status !== "released";
  const dirty = rows.filter((r) => edits[r.order_id] && editable(r));
  const verifiable = rows.filter((r) => r.result_status === "draft" && r.result_id != null);

  const saveAll = async () => {
    const bad = dirty.find((r) => isNum && get(r).value.trim() !== "" && !Number.isFinite(Number(get(r).value)));
    if (bad) { setMsg({ ok: false, text: `ค่าของ ${bad.label} ต้องเป็นตัวเลข` }); return; }
    setBusy(true);
    const items = dirty.map((r) => { const e = get(r); return { orderId: r.order_id, valueNum: isNum ? (e.value.trim() === "" ? null : Number(e.value)) : null, valueText: isNum ? null : e.value.trim() || null, unit: e.unit.trim() || null, refText: e.ref.trim() || null, interpretation: (e.interp || null) as "normal" | "abnormal" | "follow_up" | null }; });
    const r = await post("result/bulk", { items });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.message ?? "บันทึกไม่สำเร็จ" }); return; }
    const failed = (r.results as Array<{ orderId: number; ok: boolean; message?: string }>).filter((x) => !x.ok);
    setMsg({ ok: failed.length === 0, text: `บันทึกแล้ว ${r.saved} แถว${failed.length ? ` · ไม่สำเร็จ ${failed.length} แถว: ${failed.map((f) => `${rows.find((x) => x.order_id === f.orderId)?.label ?? f.orderId} (${f.message})`).join(", ")}` : ""}` });
    setEdits(Object.fromEntries(Object.entries(edits).filter(([id]) => failed.some((f) => String(f.orderId) === id))));
    router.refresh();
  };
  const verifyPicked = async () => {
    const ids = verifiable.filter((r) => picked.has(r.order_id)).map((r) => r.result_id as number);
    if (ids.length === 0) return;
    setBusy(true); const r = await post("verify", { ids }); setBusy(false);
    setMsg(r.ok ? { ok: true, text: `ตรวจสอบแล้ว ${r.verified} รายการ` } : { ok: false, text: r.message ?? "ตรวจสอบไม่สำเร็จ" });
    if (r.ok) { setPicked(new Set()); router.refresh(); }
  };

  return (
    <div className="space-y-3">
      <Banner msg={msg} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" disabled={busy || dirty.length === 0} onClick={saveAll}>บันทึกที่แก้ไข ({dirty.length})</button>
        {isApprover && (
          <>
            <button type="button" className="btn-secondary" disabled={busy || !unlocked || verifiable.filter((r) => picked.has(r.order_id)).length === 0} onClick={verifyPicked}>ตรวจสอบรายการที่เลือก ({verifiable.filter((r) => picked.has(r.order_id)).length})</button>
            <button type="button" className="text-xs underline text-slate-600" onClick={() => setPicked(new Set(verifiable.map((r) => r.order_id)))}>เลือกร่างทั้งหมด</button>
            {!unlocked && <span className="text-xs text-amber-700">ปลดล็อกด้วยเลขใบประกอบ (หน้ารายการรอบ) ก่อนจึงตรวจสอบได้</span>}
          </>
        )}
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              {isApprover && <th className="w-8 py-2 pl-3"></th>}
              <th className="py-2 pr-3">ผู้เข้าตรวจ</th><th className="py-2 pr-3">{isNum ? "ค่า" : "ผล"}</th><th className="py-2 pr-3">หน่วย</th><th className="py-2 pr-3">ค่าอ้างอิง</th><th className="py-2 pr-3">ผลแปล</th><th className="py-2 pr-3">สถานะ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const e = get(r);
              const can = editable(r);
              return (
                <tr key={r.order_id} className={`border-b border-slate-100 align-top ${edits[r.order_id] ? "bg-amber-50" : ""}`}>
                  {isApprover && <td className="py-1.5 pl-3">{r.result_status === "draft" && <input type="checkbox" checked={picked.has(r.order_id)} onChange={(ev) => setPicked((p) => { const n = new Set(p); if (ev.target.checked) n.add(r.order_id); else n.delete(r.order_id); return n; })} />}</td>}
                  <td className="py-1.5 pr-3">
                    <Link href={`/staff/health/annual-checkup/${roundId}/person/${r.key}`} className="text-brand hover:underline">{r.label}</Link>
                    <div className="text-[11px] text-slate-400">{r.code ?? "ภายนอก"} · {r.payer}</div>
                  </td>
                  {r.order_status === "waived" ? <td className="py-1.5 pr-3 text-slate-500" colSpan={4}>งดตรวจ</td> : (
                    <>
                      <td className="py-1.5 pr-3"><input className="input w-full min-w-[8rem]" value={e.value} disabled={!can} inputMode={isNum ? "decimal" : undefined} onChange={(ev) => set(r, { value: ev.target.value })} /></td>
                      <td className="py-1.5 pr-3"><input className="input w-20" value={e.unit} disabled={!can} onChange={(ev) => set(r, { unit: ev.target.value })} /></td>
                      <td className="py-1.5 pr-3"><input className="input w-28" value={e.ref} disabled={!can} onChange={(ev) => set(r, { ref: ev.target.value })} /></td>
                      <td className="py-1.5 pr-3"><select className="input" value={e.interp} disabled={!can} onChange={(ev) => set(r, { interp: ev.target.value })}><option value="">—</option>{INTERP.map((o) => <option key={o.v} value={o.v}>{o.th}</option>)}</select></td>
                    </>
                  )}
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {r.order_status === "waived" ? null : r.result_status ? <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_CLS[r.result_status]}`}>{STATUS_TH[r.result_status]}</span> : <span className="text-[11px] text-amber-700">ยังไม่ลงผล</span>}
                    {r.order_status === "external_lab" && <div className="text-[11px] text-violet-700">แล็บนอก{r.has_file ? " · มีไฟล์" : " · ต้องแนบไฟล์"}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">แถวสีเหลืองคือแถวที่แก้ไขแล้วแต่ยังไม่บันทึก · ผลที่ตรวจสอบแล้วแก้ไม่ได้ในหน้านี้ ใช้ “ทำฉบับแก้ไข” ในหน้ารายคน · แนบไฟล์ผลแล็บและบันทึกเหตุผลการงดตรวจทำในหน้ารายคน</p>
    </div>
  );
}
