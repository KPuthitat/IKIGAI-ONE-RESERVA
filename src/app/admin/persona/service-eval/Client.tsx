"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/url";

type Result = "pass" | "fail" | "na";
type Item = { id: number; code: string; section: "steps" | "donts"; title: string; tip: string | null };
type Fail = { itemId: number; code: string; title: string; tip: string | null; note: string | null };
type Ev = { id: number; userId: number; name: string; date: string; score: number | null; note: string | null; evaluator: string; notified: boolean; fails: Fail[]; marks: Array<{ itemId: number; result: Result; note: string | null }> };
type Person = { userId: number; name: string; evals: number; avgScore: number | null; lastScore: number | null; trend: "up" | "down" | "flat" | null };
type Summary = { from: string; to: string; evals: number; avgScore: number | null; people: Person[]; topFails: Array<{ code: string; title: string; count: number }> };
type Data = { date: string; items: Item[]; staff: Array<{ id: number; name: string }>; evals: Ev[]; week: Summary; month: Summary; hasGroup: boolean };

const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const LABEL: Record<Item["section"], [string, string, string]> = { steps: ["ทำได้ดี", "ยังไม่ดี", "ไม่เกี่ยวข้อง"], donts: ["ไม่พบ", "พบ", "ไม่เกี่ยวข้อง"] };
const scoreCls = (s: number | null) => s == null ? "text-slate-500" : s >= 90 ? "text-emerald-700" : s >= 70 ? "text-amber-700" : "text-rose-700";
const TREND: Record<string, string> = { up: "▲ ดีขึ้น", down: "▼ แย่ลง", flat: "– ทรงตัว" };

export default function Client() {
  const [date, setDate] = useState(today());
  const [data, setData] = useState<Data | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [marks, setMarks] = useState<Record<number, { result: Result; note: string }>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [range, setRange] = useState<"week" | "month">("week");

  const load = useCallback(async (d: string) => {
    const r = await fetch(apiUrl(`/api/admin/persona/service-eval?date=${d}`), { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) { setMsg({ ok: false, text: "ไม่สามารถแสดงข้อมูลได้" }); return; }
    setData(j);
  }, []);
  useEffect(() => { load(date); }, [date, load]);

  // picking a person loads what is already saved for that day, so a correction is an edit, not a duplicate
  useEffect(() => {
    if (!data || userId == null) { setMarks({}); setNote(""); return; }
    const e = data.evals.find((x) => x.userId === userId);
    setMarks(e ? Object.fromEntries(e.marks.map((m) => [m.itemId, { result: m.result, note: m.note ?? "" }])) : {});
    setNote(e?.note ?? "");
  }, [userId, data]);

  async function post(body: Record<string, unknown>) {
    setBusy(true); setMsg(null);
    const r = await fetch(apiUrl("/api/admin/persona/service-eval"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: j.message ?? "ทำรายการไม่สำเร็จ" }); return null; }
    return j;
  }

  const steps = useMemo(() => data?.items.filter((i) => i.section === "steps") ?? [], [data]);
  const donts = useMemo(() => data?.items.filter((i) => i.section === "donts") ?? [], [data]);
  const marked = Object.keys(marks).length;

  async function save() {
    if (userId == null) return;
    const j = await post({ action: "save", date, user_id: userId, note: note || null, marks: Object.entries(marks).map(([id, m]) => ({ item_id: Number(id), result: m.result, note: m.note || null })) });
    if (j) { setMsg({ ok: true, text: `บันทึกแล้ว · คะแนน ${j.score ?? "-"}%` }); setUserId(null); await load(date); }
  }

  if (!data) return <div className="card text-sm text-slate-500">{msg?.text ?? "กำลังโหลด"}</div>;
  const sum = range === "week" ? data.week : data.month;

  const block = (title: string, list: Item[], section: Item["section"]) => (
    <section className="card space-y-3">
      <h2 className="font-bold text-slate-800">{title}</h2>
      {list.map((it) => {
        const m = marks[it.id];
        const set = (result: Result) => setMarks((s) => s[it.id]?.result === result ? Object.fromEntries(Object.entries(s).filter(([k]) => Number(k) !== it.id)) : { ...s, [it.id]: { result, note: s[it.id]?.note ?? "" } });
        return (
          <div key={it.id} className="space-y-1.5 border-t border-slate-100 pt-2 first:border-0 first:pt-0">
            <div className="text-sm text-slate-800">{it.title}</div>
            <div className="flex gap-1.5 flex-wrap">
              {(["pass", "fail", "na"] as const).map((r, i) => (
                <button key={r} type="button" aria-pressed={m?.result === r} onClick={() => set(r)}
                  className={`chip ${m?.result === r ? (r === "fail" ? "!bg-rose-600 !text-white !border-rose-600" : r === "pass" ? "!bg-emerald-600 !text-white !border-emerald-600" : "chip-active") : ""}`}>{LABEL[section][i]}</button>
              ))}
            </div>
            {m?.result === "fail" && <input className="input" placeholder="หมายเหตุ (ไม่บังคับ)" value={m.note} maxLength={200} onChange={(e) => setMarks((s) => ({ ...s, [it.id]: { ...s[it.id], note: e.target.value } }))} />}
          </div>
        );
      })}
    </section>
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ประเมินการบริการหน้าร้าน</h1>
        <p className="text-sm text-slate-500 mt-1">หัวหน้าร้านติ๊กตามขั้นตอนบริการและข้อห้ามต่อหน้าลูกค้าจาก SOP ได้ทุกวัน แล้วส่งสรุปเข้ากลุ่ม LINE หรือแจ้งพนักงานรายคนพร้อมข้อแนะนำ คะแนนใช้เพื่อการโค้ช ไม่เกี่ยวกับการจ่ายเงิน</p>
      </div>
      {msg && <div className={`card text-sm ${msg.ok ? "text-emerald-800 bg-emerald-50 border-emerald-200" : "text-rose-800 bg-rose-50 border-rose-200"}`} role="status">{msg.text}</div>}

      <section className="card space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="text-sm">วันที่ประเมิน<input type="date" className="input mt-1" max={today()} value={date} onChange={(e) => { setUserId(null); setDate(e.target.value || today()); }} /></label>
          <label className="text-sm">พนักงานที่ประเมิน
            <select className="input mt-1" value={userId ?? ""} onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">เลือกพนักงาน</option>
              {data.staff.map((s) => <option key={s.id} value={s.id}>{s.name}{data.evals.some((e) => e.userId === s.id) ? " (ประเมินแล้ว)" : ""}</option>)}
            </select>
          </label>
        </div>
      </section>

      {userId != null && (
        <>
          {block("ขั้นตอนการให้บริการลูกค้า", steps, "steps")}
          {block("สิ่งที่ไม่ควรทำต่อหน้าลูกค้า", donts, "donts")}
          <section className="card space-y-3">
            <label className="text-sm">หมายเหตุเพิ่มเติม (ไม่บังคับ)<textarea className="input mt-1" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <button type="button" className="btn-primary w-full" disabled={busy || marked === 0} onClick={save}>บันทึกผลประเมิน ({marked} ข้อ)</button>
          </section>
        </>
      )}

      <section className="card space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="font-bold text-slate-800">ผลประเมินวันที่ {date}</h2>
          <button type="button" className="btn-secondary" disabled={busy || data.evals.length === 0 || !data.hasGroup}
            onClick={async () => { if (window.confirm(`ส่งสรุปผลประเมิน ${data.evals.length} คน เข้ากลุ่ม LINE ใช่หรือไม่`)) { const j = await post({ action: "send_group", date }); if (j) setMsg({ ok: true, text: `ส่งสรุป ${j.count} คน เข้ากลุ่ม LINE แล้ว` }); } }}>ส่งสรุปเข้ากลุ่ม LINE</button>
        </div>
        {!data.hasGroup && <p className="text-xs text-amber-700">สาขานี้ยังไม่ได้ตั้งกลุ่ม LINE หัวหน้างาน จึงยังส่งเข้ากลุ่มไม่ได้</p>}
        {data.evals.length === 0 && <p className="text-sm text-slate-500">ยังไม่มีผลประเมินของวันนี้</p>}
        {data.evals.map((e) => (
          <div key={e.id} className="rounded-xl border border-slate-200 p-3 space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <div className="font-bold text-slate-800">{e.name}</div>
              <div className={`font-bold ${scoreCls(e.score)}`}>{e.score == null ? "-" : `${e.score}%`}</div>
            </div>
            {e.fails.length > 0 ? <ul className="text-xs text-rose-700 list-disc pl-4">{e.fails.map((f) => <li key={f.itemId}>{f.title}{f.note ? ` (${f.note})` : ""}</li>)}</ul> : <p className="text-xs text-emerald-700">ผ่านทุกข้อที่ประเมิน</p>}
            {e.note && <p className="text-xs text-slate-500">หมายเหตุ: {e.note}</p>}
            <div className="flex gap-2 flex-wrap pt-1">
              <button type="button" className="chip" onClick={() => { setUserId(e.userId); window.scrollTo({ top: 0, behavior: "smooth" }); }}>แก้ไข</button>
              <button type="button" className="chip" disabled={busy} onClick={async () => { const j = await post({ action: "notify_staff", eval_id: e.id }); if (j) { setMsg({ ok: true, text: `แจ้ง ${e.name} ทาง LINE แล้ว` }); await load(date); } }}>{e.notified ? "แจ้งพนักงานอีกครั้ง" : "แจ้งพนักงานทาง LINE"}</button>
              {e.notified && <span className="text-xs text-slate-400 self-center">แจ้งแล้ว</span>}
            </div>
          </div>
        ))}
      </section>

      <section className="card space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="font-bold text-slate-800">แนวโน้ม</h2>
          <div className="flex gap-1.5">
            <button type="button" aria-pressed={range === "week"} className={`chip ${range === "week" ? "chip-active" : ""}`} onClick={() => setRange("week")}>สัปดาห์นี้</button>
            <button type="button" aria-pressed={range === "month"} className={`chip ${range === "month" ? "chip-active" : ""}`} onClick={() => setRange("month")}>4 สัปดาห์</button>
          </div>
        </div>
        <p className="text-xs text-slate-500">{sum.from} ถึง {sum.to} · ประเมินแล้ว {sum.evals} ครั้ง · เฉลี่ยรวม {sum.avgScore == null ? "-" : `${sum.avgScore}%`}</p>
        {sum.people.length === 0 ? <p className="text-sm text-slate-500">ยังไม่มีข้อมูลในช่วงนี้</p> : (
          <ul className="divide-y divide-slate-100">
            {sum.people.map((p) => (
              <li key={p.userId} className="py-2 flex items-center justify-between gap-2 text-sm">
                <span className="text-slate-800">{p.name} <span className="text-xs text-slate-400">({p.evals} ครั้ง)</span></span>
                <span className="flex items-center gap-2"><span className="text-xs text-slate-500">{p.trend ? TREND[p.trend] : ""}</span><b className={scoreCls(p.avgScore)}>{p.avgScore == null ? "-" : `${p.avgScore}%`}</b></span>
              </li>
            ))}
          </ul>
        )}
        {sum.topFails.length > 0 && (
          <div>
            <div className="text-xs font-bold text-slate-700 mb-1">ข้อที่พลาดบ่อยที่สุด</div>
            <ul className="text-sm text-slate-700 list-disc pl-5">{sum.topFails.map((f) => <li key={f.code}>{f.title} — {f.count} ครั้ง</li>)}</ul>
          </div>
        )}
      </section>
    </div>
  );
}
