"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { formatLongDate } from "@/lib/time";
import { humanizeApiError } from "@/lib/error-messages";
import { FEASIBILITY_COMPANIES } from "@/lib/feasibility";

type Summary = { verdict: "go" | "caution" | "no"; profit: number; paybackMonths: number };
type Card = {
  id: number;
  company: string;
  project_name: string;
  location: string | null;
  status: string;
  updated_at: string;
  summary: Summary | null;
};

const VERDICT: Record<Summary["verdict"], { label: string; cls: string }> = {
  go: { label: "น่าลงทุน", cls: "bg-emerald-100 text-emerald-800" },
  caution: { label: "ทำได้ แต่มีความเสี่ยง", cls: "bg-amber-100 text-amber-800" },
  no: { label: "ไม่ควรลงทุน", cls: "bg-rose-100 text-rose-700" }
};

function payback(m: number): string {
  return Number.isFinite(m) ? `${m.toFixed(2)} เดือน` : "—";
}

export default function FeasibilityClient({ projects }: { projects: Card[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [company, setCompany] = useState<string>("");
  const [status, setStatus] = useState<string>("active"); // hide archived by default

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return projects.filter((p) => {
      if (company && p.company !== company) return false;
      if (status === "active" && p.status === "archived") return false;
      if (status === "archived" && p.status !== "archived") return false;
      if (needle && !p.project_name.toLowerCase().includes(needle)
        && !(p.location ?? "").toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [projects, q, company, status]);

  async function createNew() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/feasibility"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: "MEDIHEALTH", project_name: "โปรเจคใหม่" })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "สร้างโปรเจคไม่สำเร็จ")); return; }
      router.push(`/admin/feasibility/${j.id}`);
    } finally { setBusy(false); }
  }

  async function act(id: number, action: "duplicate" | "archive" | "unarchive") {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/feasibility/${id}/action`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ทำรายการไม่สำเร็จ")); return; }
      if (action === "duplicate" && j.id) { router.push(`/admin/feasibility/${j.id}`); return; }
      refresh();
    } finally { setBusy(false); }
  }

  async function remove(id: number, name: string) {
    if (!window.confirm(`ลบโปรเจค "${name}" ? การลบนี้กู้คืนไม่ได้`)) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/feasibility/${id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ลบไม่สำเร็จ")); return; }
      refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={createNew} disabled={busy}
          className="btn-primary disabled:opacity-50">
          + เพิ่มโปรเจคใหม่
        </button>
        <input className="input !w-auto flex-1 min-w-[160px]" placeholder="ค้นหาชื่อ / ทำเล"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input !w-auto" value={company} onChange={(e) => setCompany(e.target.value)}>
          <option value="">ทุกบริษัท</option>
          {FEASIBILITY_COMPANIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input !w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">ใช้งานอยู่</option>
          <option value="archived">เก็บถาวร</option>
          <option value="">ทั้งหมด</option>
        </select>
      </div>

      {err && <p className="text-sm text-rose-600">{err}</p>}

      {filtered.length === 0 ? (
        <div className="card text-center py-10 space-y-3">
          <p className="text-slate-500">
            {projects.length === 0
              ? "ยังไม่มีโปรเจค — เริ่มประเมินความเป็นไปได้ของการลงทุนแรกของคุณ"
              : "ไม่พบโปรเจคที่ตรงกับตัวกรอง"}
          </p>
          <button type="button" onClick={createNew} disabled={busy}
            className="btn-primary disabled:opacity-50">+ เพิ่มโปรเจคใหม่</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((p) => {
            const v = p.summary ? VERDICT[p.summary.verdict] : null;
            return (
              <div key={p.id} className="card space-y-2 flex flex-col">
                <button type="button" onClick={() => router.push(`/admin/feasibility/${p.id}`)}
                  className="text-left space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] tracking-wide text-slate-400">{p.company}</span>
                    {v && <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${v.cls}`}>{v.label}</span>}
                  </div>
                  <h3 className="font-bold text-slate-800">{p.project_name}</h3>
                  {p.location && <p className="text-xs text-slate-500">{p.location}</p>}
                </button>
                {p.summary && (
                  <div className="grid grid-cols-2 gap-2 text-sm border-t border-slate-100 pt-2">
                    <div>
                      <div className="text-[10px] text-slate-400">กำไร/เดือน</div>
                      <div className={`font-bold ${p.summary.profit > 0 ? "text-slate-800" : "text-rose-600"}`}>
                        ฿{fmtMoney(p.summary.profit)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-400">คืนทุน</div>
                      <div className="font-bold text-slate-800">{payback(p.summary.paybackMonths)}</div>
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between gap-1 text-[11px] text-slate-400 mt-auto pt-1">
                  <span>แก้ไข {formatLongDate(p.updated_at.slice(0, 10), "th")}</span>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => act(p.id, "duplicate")} disabled={busy}
                      className="hover:text-brand" title="คัดลอกเป็นแม่แบบ">คัดลอก</button>
                    {p.status === "archived" ? (
                      <button type="button" onClick={() => act(p.id, "unarchive")} disabled={busy}
                        className="hover:text-emerald-600" title="นำกลับมาใช้">เลิกเก็บ</button>
                    ) : (
                      <button type="button" onClick={() => act(p.id, "archive")} disabled={busy}
                        className="hover:text-amber-600" title="เก็บถาวร">เก็บ</button>
                    )}
                    <button type="button" onClick={() => remove(p.id, p.project_name)} disabled={busy}
                      className="hover:text-rose-600" title="ลบ">ลบ</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
