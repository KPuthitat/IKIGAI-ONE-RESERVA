"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";

type Dimension = { id: number; grp: string; name: string; description: string | null; default_target: number; sort_order: number };
type CatalogItem = { id: number; track: string; grp: string; name: string };
type AssessUser = { id: number; display_name: string; employment_type: string | null };
type ScoreRow = { dimension_id: number; name: string; grp: string; description: string | null; self_score: number | null; reviewer_score: number | null; target_score: number; note: string | null };
type Initial = { assessmentId: number; track: string | null; status: "draft" | "final"; note: string | null; userName: string; scores: ScoreRow[] } | null;

const SCALE = 5;
const GRP_LABEL: Record<string, string> = { professional: "ทักษะวิชาชีพ", soft: "Soft skill", managing: "Managing skill" };
const TRACK_LABEL: Record<string, string> = { restaurant: "ร้านอาหาร", clinic: "คลินิก", admin: "แอดมิน/หลังบ้าน" };
const SHORT: Record<string, string> = {
  "ทักษะวิชาชีพตามตำแหน่ง": "ทักษะวิชาชีพ", "คุณภาพงาน/ความแม่นยำ": "คุณภาพงาน", "ใจรักบริการ": "ใจรักบริการ",
  "การสื่อสาร/ทำงานเป็นทีม": "สื่อสาร/ทีม", "ความรับผิดชอบ/วินัย/ตรงเวลา": "วินัย/ตรงเวลา",
  "การแก้ปัญหา/ปรับตัว": "แก้ปัญหา", "ภาวะผู้นำ/วางแผน/สอนงาน": "ภาวะผู้นำ"
};
const shortOf = (n: string) => SHORT[n] ?? (n.length > 9 ? n.slice(0, 9) + "…" : n);

// SVG radar — target (dashed) + self (amber) + reviewer (teal) over N axes.
function Radar({ axes }: { axes: Array<{ label: string; self: number | null; reviewer: number | null; target: number }> }) {
  const N = axes.length || 1;
  const cx = 190, cy = 162, R = 108;
  const ang = (i: number) => ((-90 + (i * 360) / N) * Math.PI) / 180;
  const pt = (i: number, v: number): [number, number] => [cx + (v / SCALE) * R * Math.cos(ang(i)), cy + (v / SCALE) * R * Math.sin(ang(i))];
  const poly = (vals: Array<number | null>) => vals.map((v, i) => pt(i, v ?? 0).map((n) => n.toFixed(1)).join(",")).join(" ");
  return (
    <svg viewBox="0 0 380 330" width="100%" style={{ maxWidth: 420, display: "block", margin: "0 auto" }} role="img" aria-label="เรดาร์สมรรถนะ">
      {[1, 2, 3, 4, 5].map((lv) => (
        <polygon key={lv} points={axes.map((_, i) => pt(i, lv).map((n) => n.toFixed(1)).join(",")).join(" ")} fill="none" stroke="#eef2f7" strokeWidth={1} />
      ))}
      {axes.map((a, i) => {
        const [x, y] = pt(i, SCALE);
        const [lx, ly] = pt(i, SCALE + 0.75);
        const anchor = Math.abs(lx - cx) < 6 ? "middle" : lx < cx ? "end" : "start";
        return (
          <g key={i}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke="#e2e8f0" strokeWidth={1} />
            <text x={lx} y={ly + 3} fontSize={8.5} fill="#475569" textAnchor={anchor}>{a.label}</text>
          </g>
        );
      })}
      <polygon points={poly(axes.map((a) => a.target))} fill="none" stroke="#94a3b8" strokeWidth={1.2} strokeDasharray="4 3" />
      <polygon points={poly(axes.map((a) => a.self))} fill="rgba(226,160,63,0.10)" stroke="#E2A03F" strokeWidth={1.3} />
      <polygon points={poly(axes.map((a) => a.reviewer))} fill="rgba(29,158,117,0.18)" stroke="#1D9E75" strokeWidth={2} />
      {axes.map((a, i) => a.reviewer != null && <circle key={i} cx={pt(i, a.reviewer)[0]} cy={pt(i, a.reviewer)[1]} r={2.2} fill="#1D9E75" />)}
    </svg>
  );
}

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

export default function CompetencyClient({
  users, userId, period, dimensions, catalog, initial
}: { users: AssessUser[]; userId: number | null; period: string; dimensions: Dimension[]; catalog: CatalogItem[]; initial: Initial }) {
  const router = useRouter();
  const [rows, setRows] = useState<ScoreRow[]>(initial?.scores ?? []);
  const [track, setTrack] = useState<string | null>(initial?.track ?? null);
  const [status, setStatus] = useState<"draft" | "final">(initial?.status ?? "draft");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [py, pq] = period.split("-");
  const year = Number(py);

  function go(u: number | null, p: string) {
    const q = new URLSearchParams();
    if (u) q.set("user", String(u));
    q.set("period", p);
    router.push(`/admin/ascenda/competency?${q.toString()}`);
  }

  function setScore(dimId: number, field: "self_score" | "reviewer_score" | "target_score", v: string) {
    const num = v === "" ? null : Math.max(0, Math.min(SCALE, Number(v)));
    setRows((rs) => rs.map((r) => (r.dimension_id === dimId ? { ...r, [field]: num } : r)));
  }

  async function save(action: "save" | "finalize" | "reopen") {
    if (!initial) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/ascenda/competency"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assessment_id: initial.assessmentId, action, track,
          scores: rows.map((r) => ({ dimension_id: r.dimension_id, self_score: r.self_score, reviewer_score: r.reviewer_score, target_score: r.target_score }))
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      if (action === "finalize") setStatus("final");
      if (action === "reopen") setStatus("draft");
      setMsg(action === "finalize" ? "ยืนยันผลแล้ว" : action === "reopen" ? "กลับเป็นร่าง" : "บันทึกแล้ว");
      router.refresh();
    } finally { setBusy(false); }
  }

  const axes = rows.map((r) => ({ label: shortOf(r.name), self: r.self_score, reviewer: r.reviewer_score, target: r.target_score }));
  const weak = rows.filter((r) => r.reviewer_score != null && r.reviewer_score < r.target_score);
  const grouped = (["professional", "soft", "managing"] as const).map((g) => ({ g, rows: rows.filter((r) => r.grp === g) }));
  const trackCatalog = track ? catalog.filter((c) => c.track === track) : [];

  return (
    <div className="space-y-4">
      {/* Pickers */}
      <div className="card flex flex-wrap items-end gap-3">
        <div>
          <label className="label">พนักงาน</label>
          <select className="input min-w-[12rem]" value={userId ?? ""} onChange={(e) => go(Number(e.target.value) || null, period)}>
            <option value="">— เลือกพนักงาน —</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.display_name}{u.employment_type === "pt" ? " (PT)" : u.employment_type === "ft" ? " (FT)" : ""}</option>)}
          </select>
        </div>
        <div>
          <label className="label">รอบประเมิน</label>
          <div className="flex gap-2">
            <select className="input w-24" value={year} onChange={(e) => go(userId, `${e.target.value}-${pq}`)}>
              {[year - 2, year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y + 543}</option>)}
            </select>
            <select className="input w-20" value={pq} onChange={(e) => go(userId, `${py}-${e.target.value}`)}>
              {QUARTERS.map((q) => <option key={q} value={q}>{q}</option>)}
            </select>
          </div>
        </div>
      </div>

      {err && <p className="text-sm text-rose-600">{err}</p>}
      {msg && <p className="text-sm text-emerald-700">✓ {msg}</p>}

      {!initial ? (
        <div className="card text-sm text-slate-400">เลือกพนักงานเพื่อเริ่มประเมิน</div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm text-slate-600">ประเมิน: <b className="text-slate-800">{initial.userName}</b> · รอบ {pq} ปี {year + 543}
              <span className={`ml-2 text-[11px] px-2 py-0.5 rounded ${status === "final" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{status === "final" ? "ยืนยันแล้ว" : "ร่าง"}</span>
            </div>
            <div>
              <label className="text-[11px] text-slate-500 mr-1">สายงาน:</label>
              <select className="input w-44 inline-block" value={track ?? ""} onChange={(e) => setTrack(e.target.value || null)}>
                <option value="">— เลือกสายงาน —</option>
                {Object.keys(TRACK_LABEL).map((t) => <option key={t} value={t}>{TRACK_LABEL[t]}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
            {/* Radar */}
            <div className="card">
              <div className="flex flex-wrap gap-3 text-[11px] text-slate-500 mb-1">
                <span className="flex items-center gap-1"><span className="w-3.5 h-[3px] rounded" style={{ background: "#94a3b8" }} />เป้าของตำแหน่ง</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#1D9E75" }} />หัวหน้าประเมิน</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#E2A03F" }} />ประเมินตัวเอง</span>
              </div>
              <Radar axes={axes} />
            </div>

            {/* Weak points + catalog */}
            <div className="space-y-3">
              <div className="card space-y-2">
                <div className="text-sm font-bold text-slate-800">จุดอ่อน (ต่ำกว่าเป้า) → ไปวางแผนพัฒนา</div>
                {weak.length === 0 ? (
                  <p className="text-xs text-emerald-700">ไม่มีจุดที่ต่ำกว่าเป้า 🎉</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {weak.map((w) => (
                      <span key={w.dimension_id} className={`text-[11px] px-2 py-1 rounded-full ${w.reviewer_score! <= w.target_score - 2 ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700"}`}>
                        {w.name} {w.reviewer_score}/{w.target_score}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {track && trackCatalog.length > 0 && (
                <div className="card space-y-1.5">
                  <div className="text-sm font-bold text-slate-800">ชุดสมรรถนะ/คอร์ส · {TRACK_LABEL[track]}</div>
                  {(["professional", "soft", "managing"] as const).map((g) => {
                    const items = trackCatalog.filter((c) => c.grp === g);
                    if (!items.length) return null;
                    return (
                      <div key={g}>
                        <div className="text-[11px] font-bold text-slate-500">{GRP_LABEL[g]}</div>
                        <div className="text-[11px] text-slate-600">{items.map((it) => it.name).join(" · ")}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Score form */}
          <div className="card space-y-3">
            <div className="text-sm font-bold text-slate-800">ให้คะแนน (เต็ม {SCALE})</div>
            {grouped.map(({ g, rows: grows }) => grows.length === 0 ? null : (
              <div key={g}>
                <div className="text-[11px] font-bold text-slate-500 mb-1">{GRP_LABEL[g]}</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-[10px] text-slate-400 border-b border-slate-100">
                      <th className="text-left py-1 px-2">ด้าน</th>
                      <th className="text-center py-1 px-2 w-20">ตัวเอง</th>
                      <th className="text-center py-1 px-2 w-20">หัวหน้า</th>
                      <th className="text-center py-1 px-2 w-20">เป้า</th>
                    </tr></thead>
                    <tbody>
                      {grows.map((r) => (
                        <tr key={r.dimension_id} className="border-b border-slate-50">
                          <td className="py-1 px-2 text-slate-700">{r.name}{r.description && <span className="block text-[10px] text-slate-400">{r.description}</span>}</td>
                          <td className="py-1 px-2"><input type="number" min={0} max={SCALE} step={0.5} className="input text-center py-1" value={r.self_score ?? ""} onChange={(e) => setScore(r.dimension_id, "self_score", e.target.value)} disabled={status === "final"} /></td>
                          <td className="py-1 px-2"><input type="number" min={0} max={SCALE} step={0.5} className="input text-center py-1" value={r.reviewer_score ?? ""} onChange={(e) => setScore(r.dimension_id, "reviewer_score", e.target.value)} disabled={status === "final"} /></td>
                          <td className="py-1 px-2"><input type="number" min={0} max={SCALE} step={0.5} className="input text-center py-1" value={r.target_score ?? ""} onChange={(e) => setScore(r.dimension_id, "target_score", e.target.value)} disabled={status === "final"} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2 flex-wrap">
              {status === "draft" ? (
                <>
                  <button type="button" onClick={() => save("save")} disabled={busy} className="btn-primary text-sm disabled:opacity-50">บันทึก (ร่าง)</button>
                  <button type="button" onClick={() => save("finalize")} disabled={busy} className="btn-secondary text-sm">ยืนยันผล</button>
                </>
              ) : (
                <button type="button" onClick={() => save("reopen")} disabled={busy} className="btn-secondary text-sm">แก้ไขอีกครั้ง (กลับเป็นร่าง)</button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
