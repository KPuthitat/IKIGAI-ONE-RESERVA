"use client";

import { useRef, useState } from "react";
import { apiUrl } from "@/lib/url";
import type { ImportPlan, CommitResult } from "@/lib/annual-checkup-import";

export type RoundOption = { id: number; name: string; status: string; orders: number; people: number; yearBe: number | null; startDate: string | null; endDate: string | null; location: string | null };

const FIX_REASON: Record<string, string> = {
  not_found: "ไม่พบในระบบ", name_mismatch: "ชื่อไม่ตรงกับรหัส", ambiguous: "ตรงกับมากกว่าหนึ่งคน", inactive: "ไม่ใช่พนักงานที่ทำงานอยู่", duplicate_row: "แถวซ้ำในไฟล์"
};
const ROUND_STATUS: Record<string, string> = { draft: "ร่าง", open: "เปิดรอบ", closed: "ปิดรอบ" };

export default function ImportClient({ rounds }: { rounds: RoundOption[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [roundId, setRoundId] = useState<string>("");
  const [name, setName] = useState("ตรวจสุขภาพประจำปี 2569");
  const [yearBe, setYearBe] = useState("2569");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [location, setLocation] = useState("");
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);

  const send = async (mode: "preview" | "commit") => {
    const file = fileRef.current?.files?.[0];
    if (!file) { setMsg({ ok: false, text: "กรุณาเลือกไฟล์ Excel (.xlsx) ก่อน" }); return; }
    const f = new FormData();
    f.set("file", file); f.set("mode", mode);
    if (roundId) f.set("roundId", roundId);
    else { f.set("name", name); f.set("yearBe", yearBe); f.set("startDate", startDate); f.set("endDate", endDate); f.set("location", location); }
    if (mode === "commit" && plan) { f.set("planHash", plan.hash); if (skip) f.set("skipUnresolved", "1"); }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(apiUrl("/api/admin/persona/annual-checkup/import"), { method: "POST", body: f });
      const j = await r.json();
      if (!j.ok) { setMsg({ ok: false, text: j.message ?? j.error ?? "ทำรายการไม่สำเร็จ" }); return; }
      if (mode === "preview") { setPlan(j.plan); setResult(null); }
      else { setResult(j.result); setPlan(null); setMsg({ ok: true, text: "นำเข้าเรียบร้อยแล้ว" }); }
    } catch { setMsg({ ok: false, text: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }); }
    finally { setBusy(false); }
  };

  const blocked = !plan || plan.fileIssues.length > 0 || (plan.needsFix > 0 && !skip);
  const matched = plan?.people.filter((p) => p.match.state === "matched").length ?? 0;
  const placeholders = plan?.people.filter((p) => p.match.state === "placeholder").length ?? 0;
  const fixes = plan?.people.filter((p) => p.match.state === "needs_fix") ?? [];

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="text-sm font-semibold text-slate-800">1. เลือกรอบและไฟล์</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="label">รอบ</span>
            <select className="input w-full" value={roundId} onChange={(e) => { setRoundId(e.target.value); setPlan(null); }}>
              <option value="">สร้างรอบใหม่</option>
              {rounds.map((r) => <option key={r.id} value={r.id}>{r.name} · {ROUND_STATUS[r.status] ?? r.status} · {r.people} คน {r.orders} รายการ</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="label">ไฟล์ Excel (.xlsx)</span>
            <input ref={fileRef} type="file" accept=".xlsx" className="input w-full" onChange={() => { setPlan(null); setResult(null); }} />
          </label>
        </div>
        {!roundId && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm"><span className="label">ชื่อรอบ</span><input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="block text-sm"><span className="label">ปี พ.ศ.</span><input className="input w-full" inputMode="numeric" value={yearBe} onChange={(e) => setYearBe(e.target.value)} /></label>
            <label className="block text-sm"><span className="label">วันตรวจ (เริ่ม)</span><input type="date" className="input w-full" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
            <label className="block text-sm"><span className="label">วันตรวจ (สิ้นสุด)</span><input type="date" className="input w-full" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
            <label className="block text-sm sm:col-span-2"><span className="label">สถานที่ตรวจ</span><input className="input w-full" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="เช่น แอทโฮมคลินิก" /></label>
          </div>
        )}
        <button type="button" className="btn-primary" disabled={busy} onClick={() => send("preview")}>{busy && !plan ? "กำลังอ่านไฟล์…" : "ดูตัวอย่างก่อนนำเข้า"}</button>
        <p className="text-xs text-slate-500">ขั้นนี้ไม่บันทึกอะไรลงระบบ ไฟล์อ่านจากแผ่น “รายการตรวจรายบุคคล”, “โปรแกรมตามบริษัท” และ “รายชื่อตรวจสุขภาพ” แผ่นอื่นเป็นตารางสรุปและไม่ถูกใช้</p>
      </div>

      {msg && <div className={`rounded-lg px-4 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : "bg-rose-50 text-rose-800 border border-rose-200"}`}>{msg.text}</div>}

      {result && (
        <div className="card space-y-1 text-sm">
          <div className="font-semibold text-slate-800">ผลการนำเข้า</div>
          <div>{result.created ? "สร้างรอบใหม่" : "ปรับรอบเดิม"} · เพิ่มคำสั่งตรวจ {result.ordersAdded} · เปลี่ยน {result.ordersChanged} · ลบ {result.ordersRemoved} · เพิ่มช่องรอเติมชื่อ {result.externalsAdded} · ลำดับคิวเพิ่ม {result.queueAdded} เปลี่ยน {result.queueChanged}</div>
          {result.skippedRows > 0 && <div className="text-amber-700">ข้ามแถวที่ต้องแก้ {result.skippedRows} แถว — แก้ข้อมูลแล้วนำเข้าไฟล์เดิมอีกครั้งได้ ไม่เกิดข้อมูลซ้ำ</div>}
          {result.conflicts > 0 && <div className="text-amber-700">มี {result.conflicts} รายการที่ขัดแย้งกับผล/ข้อมูลทางคลินิก ไม่ได้เปลี่ยน</div>}
        </div>
      )}

      {plan && (
        <div className="space-y-4">
          <div className="card space-y-3">
            <div className="text-sm font-semibold text-slate-800">2. ตัวอย่างสิ่งที่จะเกิดขึ้น · {plan.round.mode === "new" ? "สร้างรอบใหม่" : "นำเข้าเข้ารอบเดิม"} “{plan.round.name}”</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-sm">
              <Stat label="พนักงานที่จับคู่ได้" value={matched} tone="ok" />
              <Stat label="ต้องแก้" value={plan.needsFix} tone={plan.needsFix ? "bad" : "ok"} />
              <Stat label="รอเพิ่มรายชื่อ (ไม่มีบัญชี)" value={placeholders} />
              <Stat label="คำสั่งตรวจที่เพิ่ม" value={plan.orders.add} />
              <Stat label="เปลี่ยน" value={plan.orders.change} />
              <Stat label="เหมือนเดิม" value={plan.orders.same} />
              <Stat label="ลบ" value={plan.orders.remove} />
              <Stat label="ขัดแย้ง (มีผลแล้ว)" value={plan.orders.conflict} tone={plan.orders.conflict ? "warn" : "ok"} />
              <Stat label="ลำดับคิวที่เพิ่ม" value={plan.queue.add} />
              <Stat label="ลำดับคิวที่เปลี่ยน" value={plan.queue.change} />
              <Stat label="ลำดับคิวเหมือนเดิม" value={plan.queue.same} />
              <Stat label="ลำดับคิวที่จัดไม่ได้" value={plan.queue.clashes.length} tone={plan.queue.clashes.length ? "warn" : "ok"} />
            </div>
            {plan.queue.clashes.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <ul className="list-disc pl-5">{plan.queue.clashes.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </div>
            )}

            {plan.fileIssues.length > 0 && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                <div className="font-semibold">ไฟล์มีปัญหา นำเข้าไม่ได้ — แก้ไฟล์แล้วเลือกใหม่</div>
                <ul className="list-disc pl-5">{plan.fileIssues.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </div>
            )}
            {plan.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <div className="font-semibold">ข้อควรทราบ</div>
                <ul className="list-disc pl-5">{plan.warnings.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </div>
            )}
          </div>

          {fixes.length > 0 && (
            <div className="card overflow-x-auto">
              <div className="text-sm font-semibold text-rose-700">แถวที่ต้องแก้ ({fixes.length}) — ระบบไม่นำเข้าแถวเหล่านี้เอง</div>
              <table className="w-full text-sm mt-2 min-w-[640px]">
                <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1 pr-3">แถว</th><th className="py-1 pr-3">รหัส</th><th className="py-1 pr-3">ชื่อในไฟล์</th><th className="py-1 pr-3">ปัญหา</th></tr></thead>
                <tbody>
                  {fixes.map((p) => p.match.state === "needs_fix" && (
                    <tr key={p.sheetRow} className="border-b border-slate-100 align-top">
                      <td className="py-1.5 pr-3 tabular-nums">{p.sheetRow}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">{p.code}</td>
                      <td className="py-1.5 pr-3">{p.name}</td>
                      <td className="py-1.5 pr-3"><span className="font-medium text-rose-700">{FIX_REASON[p.match.reason]}</span><div className="text-xs text-slate-600">{p.match.message}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-slate-500 mt-2">แก้รหัสหรือชื่อให้ตรงกับระบบพนักงาน (หรือแก้ในไฟล์) แล้วดูตัวอย่างใหม่ หรือเลือก “ข้ามแถวที่ต้องแก้” เพื่อนำเข้าเฉพาะแถวที่ถูกต้องก่อน แล้วนำเข้าไฟล์เดิมซ้ำเมื่อแก้แล้ว</p>
            </div>
          )}

          {plan.conflicts.length > 0 && (
            <div className="card overflow-x-auto">
              <div className="text-sm font-semibold text-amber-800">ขัดแย้งกับผลหรือข้อมูลทางคลินิก ({plan.conflicts.length}) — ไม่เปลี่ยนให้</div>
              <ul className="list-disc pl-5 text-sm mt-1">{plan.conflicts.map((c, i) => <li key={i}>{c.who} · {c.test} — {c.reason}</li>)}</ul>
            </div>
          )}

          <div className="card overflow-x-auto">
            <div className="text-sm font-semibold text-slate-800">จำนวนคนต่อรายการตรวจ (เทียบกับแถวรวมของไฟล์)</div>
            <table className="w-full text-sm mt-2 min-w-[560px]">
              <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1 pr-3">รายการ</th><th className="py-1 pr-3 text-right">ตรวจ</th><th className="py-1 pr-3 text-right">งด</th><th className="py-1 pr-3 text-right">แล็บนอก</th><th className="py-1 text-right">แถวรวมในไฟล์</th></tr></thead>
              <tbody>
                {plan.perTest.map((t) => (
                  <tr key={t.code} className="border-b border-slate-100">
                    <td className="py-1 pr-3">{t.nameTh}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{t.ordered}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{t.waived || "—"}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{t.externalLab || "—"}</td>
                    <td className={`py-1 text-right tabular-nums ${t.fileTotal != null && t.fileTotal !== t.ordered ? "text-rose-700 font-semibold" : "text-slate-500"}`}>{t.fileTotal ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card text-sm space-y-1">
            <div className="font-semibold text-slate-800">บริษัทผู้จ่ายและโปรแกรม</div>
            {plan.payers.map((p) => (
              <div key={p.name} className="flex flex-wrap gap-x-2">
                <span>{p.name}</span>
                <span className={p.external ? "text-amber-700" : "text-emerald-700"}>{p.external ? "บริษัทภายนอก" : "บริษัทในระบบ"}</span>
                <span className="text-slate-500">{p.isNew ? "เพิ่มใหม่" : "มีอยู่แล้ว"}{plan.programmes.find((g) => g.payer === p.name) ? ` · โปรแกรม ${plan.programmes.find((g) => g.payer === p.name)!.testCount} รายการ` : ""}</span>
              </div>
            ))}
          </div>

          <details className="card text-sm">
            <summary className="cursor-pointer font-semibold text-slate-800">รายชื่อทั้งหมดที่อ่านได้ ({plan.people.length})</summary>
            <div className="overflow-x-auto mt-2">
              <table className="w-full min-w-[640px]">
                <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1 pr-3">แถว</th><th className="py-1 pr-3">รหัส</th><th className="py-1 pr-3">ชื่อ</th><th className="py-1 pr-3">ผู้จ่าย</th><th className="py-1 pr-3 text-right">ตรวจ/งด/แล็บนอก</th><th className="py-1">สถานะ</th></tr></thead>
                <tbody>
                  {plan.people.map((p) => (
                    <tr key={p.sheetRow} className="border-b border-slate-100 align-top">
                      <td className="py-1 pr-3 tabular-nums">{p.sheetRow}</td><td className="py-1 pr-3 whitespace-nowrap">{p.code ?? "—"}</td><td className="py-1 pr-3">{p.name}</td><td className="py-1 pr-3 text-xs">{p.payer}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{p.ordered}/{p.waived}/{p.externalLab}</td>
                      <td className="py-1 text-xs">
                        {p.match.state === "matched" && <><span className="text-emerald-700">จับคู่แล้ว</span>{p.match.warnings.map((w, i) => <div key={i} className="text-amber-700">{w}</div>)}</>}
                        {p.match.state === "placeholder" && <span className="text-slate-600">รอเพิ่มรายชื่อ คนที่ {p.match.sortNo}</span>}
                        {p.match.state === "needs_fix" && <span className="text-rose-700">ต้องแก้</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <div className="card space-y-2">
            <div className="text-sm font-semibold text-slate-800">3. ยืนยัน</div>
            {plan.needsFix > 0 && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
                <span>ข้ามแถวที่ต้องแก้ ({plan.needsFix} แถว) แล้วนำเข้าเฉพาะแถวที่ถูกต้อง</span>
              </label>
            )}
            <button type="button" className="btn-primary" disabled={busy || blocked} onClick={() => send("commit")}>{busy ? "กำลังนำเข้า…" : "ยืนยันนำเข้า"}</button>
            {blocked && plan.fileIssues.length === 0 && plan.needsFix > 0 && <p className="text-xs text-slate-500">ยังมีแถวที่ต้องแก้ — แก้ให้ครบ หรือเลือก “ข้ามแถวที่ต้องแก้” จึงจะยืนยันได้</p>}
            <p className="text-xs text-slate-500">การนำเข้าเก็บเฉพาะ “ใครต้องตรวจรายการไหน” (✓ / งด / แล็บนอก) ไม่เก็บเหตุผลทางการแพทย์ของการงดตรวจ และไม่แตะรายการที่มีผลแล้ว</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "bad" }) {
  const cls = tone === "bad" ? "text-rose-700" : tone === "warn" ? "text-amber-700" : "text-slate-800";
  return <div className="rounded-lg border border-slate-200 px-3 py-2"><div className="text-[11px] text-slate-500">{label}</div><div className={`text-xl font-bold tabular-nums ${cls}`}>{value}</div></div>;
}
