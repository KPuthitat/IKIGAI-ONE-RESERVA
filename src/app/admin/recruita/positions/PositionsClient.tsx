"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiUrl } from "@/lib/url";

type Position = {
  id: number;
  branch_id: number | null;
  branch_name: string | null;
  code: string | null;
  title: string;
  department: string | null;
  employment_type: "ft" | "pt" | "contract" | null;
  jd_summary: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_type: "hourly" | "daily" | "monthly";
  vacancies: number;
  status: "open" | "closed" | "draft";
  opened_at: string;
  closed_at: string | null;
  application_count: number;
  hired_count: number;
  custom_questions: string;
};

type Branch = { id: number; name: string };
type PersonaTitle = { title: string; description: string | null };

const STATUS_META: Record<Position["status"], { label: string; chip: string }> = {
  open:   { label: "เปิดรับ", chip: "bg-emerald-100 text-emerald-700" },
  draft:  { label: "ร่าง",   chip: "bg-slate-200 text-slate-600" },
  closed: { label: "ปิดแล้ว", chip: "bg-rose-100 text-rose-600" }
};

const EMP_LABEL: Record<NonNullable<Position["employment_type"]>, string> = {
  // Owner spec 2026-06-01:
  //   FT       = พนักงานประจำ (career hire, monthly salary)
  //   PT       = พนักงานพาร์ทไทม์ (hourly cover shifts)
  //   contract = พนักงานสัญญาจ้างระยะสั้น (fixed-term project hire)
  // Earlier draft used "เต็มเวลา / นอกเวลา" which doesn't carry the
  // employment-status meaning the owner wanted.
  ft: "พนักงานประจำ", pt: "พนักงานพาร์ทไทม์", contract: "พนักงานสัญญาจ้างระยะสั้น"
};

const SALARY_UNIT: Record<Position["salary_type"], string> = {
  monthly: "บาท/เดือน",
  daily:   "บาท/วัน",
  hourly:  "บาท/ชม."
};

function fmtSalary(
  min: number | null,
  max: number | null,
  type: Position["salary_type"]
): string {
  const unit = SALARY_UNIT[type];
  if (min == null && max == null) return "—";
  if (min != null && max != null) {
    return `${min.toLocaleString("th-TH")}–${max.toLocaleString("th-TH")} ${unit}`;
  }
  return `${(min ?? max ?? 0).toLocaleString("th-TH")}+ ${unit}`;
}

/** Case-insensitive match against the PERSONA roster_positions
 *  catalogue. Trims whitespace on both sides — admin's typed value
 *  and the catalogue title are normalised the same way the server
 *  query de-duped them. */
function isExistingPersonaTitle(
  candidate: string,
  catalogue: PersonaTitle[]
): boolean {
  const needle = candidate.trim().toLowerCase();
  if (!needle) return false;
  return catalogue.some((p) => p.title.trim().toLowerCase() === needle);
}

export default function PositionsClient({
  positions, branches, personaTitles
}: {
  positions: Position[];
  branches: Branch[];
  personaTitles: PersonaTitle[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [showNew, setShowNew] = useState(false);
  const [filter, setFilter] = useState<Position["status"] | "all">("all");
  const [busy, setBusy] = useState(false);

  const refresh = () => startTransition(() => router.refresh());

  const filtered = filter === "all"
    ? positions
    : positions.filter((p) => p.status === filter);

  const counts = {
    all: positions.length,
    open: positions.filter((p) => p.status === "open").length,
    draft: positions.filter((p) => p.status === "draft").length,
    closed: positions.filter((p) => p.status === "closed").length
  };

  // Group by branch (null → "ทุกสาขา") so the admin list reads the same
  // way as the public /recruita/positions page — consistent layout +
  // no "some rows show a branch, some don't" confusion.
  const groups: Array<[string, Position[]]> = (() => {
    const m = new Map<string, Position[]>();
    for (const p of filtered) {
      const key = p.branch_name ?? "ทุกสาขา";
      const arr = m.get(key) ?? [];
      arr.push(p);
      m.set(key, arr);
    }
    return [...m.entries()];
  })();

  async function quickClose(id: number, title: string) {
    if (!confirm(`ปิดรับสมัครตำแหน่ง "${title}" ?`)) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/recruita/positions/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "closed" })
      });
      if (res.ok) refresh();
    } finally { setBusy(false); }
  }

  async function quickOpen(id: number) {
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/recruita/positions/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "open" })
      });
      if (res.ok) refresh();
    } finally { setBusy(false); }
  }

  async function del(id: number, title: string) {
    if (!confirm(`ลบตำแหน่ง "${title}" ?\n\n(ถ้ามีใบสมัครแล้ว ระบบจะเปลี่ยนเป็นปิดรับแทน — ใบสมัครเดิมจะไม่หาย)`)) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/recruita/positions/${id}`), {
        method: "DELETE"
      });
      if (res.ok) refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      {/* Filter chips + new button */}
      <div className="card flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1.5 flex-wrap">
          {(["all", "open", "draft", "closed"] as const).map((k) => (
            <button key={k} type="button"
              onClick={() => setFilter(k)}
              className={`text-xs px-3 py-1.5 rounded-md border ${
                filter === k
                  ? "bg-brand text-white border-brand font-bold"
                  : "border-slate-300 text-slate-600 hover:bg-slate-50"
              }`}>
              {k === "all" ? "ทั้งหมด" : STATUS_META[k].label} ({counts[k]})
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setShowNew(true)}
          className="btn-primary text-sm">
          + ตำแหน่งใหม่
        </button>
      </div>

      {/* List — grouped by branch (same layout as the public page) */}
      <div className="space-y-4">
        {filtered.length === 0 && (
          <div className="card text-sm text-slate-400 text-center py-8">
            {filter === "all"
              ? "ยังไม่มีตำแหน่งงาน — กด \"+ ตำแหน่งใหม่\" เพื่อสร้างตำแหน่งแรก"
              : "ไม่มีตำแหน่งในกลุ่มนี้"}
          </div>
        )}
        {groups.map(([branch, list]) => (
          <section key={branch} className="space-y-2">
            <div className="px-1 pb-1 border-b-2 border-amber-300/60">
              <h2 className="text-sm font-bold text-slate-800">{branch}</h2>
              <p className="text-[10px] text-slate-500">{list.length} ตำแหน่ง</p>
            </div>
            {list.map((p) => {
              const meta = STATUS_META[p.status];
              const customCount = (() => {
                try { return JSON.parse(p.custom_questions).length || 0; }
                catch { return 0; }
              })();
              return (
                <div key={p.id} className="card flex flex-col sm:flex-row gap-3 sm:items-start">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {p.code && (
                        <span className="text-xs font-bold uppercase tracking-wide bg-slate-100 text-slate-700 px-2 py-0.5 rounded">
                          {p.code}
                        </span>
                      )}
                      <h3 className="font-bold text-slate-800">{p.title}</h3>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${meta.chip}`}>
                        {meta.label}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-1 flex items-center gap-x-3 gap-y-1 flex-wrap">
                      {p.department && <span>{p.department}</span>}
                      {p.employment_type && <span>{EMP_LABEL[p.employment_type]}</span>}
                      <span className="text-emerald-700 font-semibold">
                        {fmtSalary(p.salary_min, p.salary_max, p.salary_type)}
                      </span>
                      <span className="font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full">
                        รับ {p.vacancies} อัตรา
                      </span>
                    </div>
                    {p.jd_summary && (
                      <p className="text-xs text-slate-600 mt-1.5 line-clamp-2">{p.jd_summary}</p>
                    )}
                    <div className="text-[11px] text-slate-400 mt-2 flex items-center gap-3 flex-wrap">
                      <span>ใบสมัคร {p.application_count} รายการ</span>
                      <span>✅ จ้างแล้ว {p.hired_count} คน</span>
                      <span>❓ คำถามเฉพาะตำแหน่ง {customCount} ข้อ</span>
                    </div>
                  </div>
                  <div className="flex sm:flex-col gap-2 flex-shrink-0 text-xs">
                    <Link href={`/admin/recruita/positions/${p.id}`}
                      className="px-3 py-1.5 rounded-lg bg-brand text-white font-bold text-center">
                      แก้ไข
                    </Link>
                    {p.status === "open" ? (
                      <button type="button" disabled={busy}
                        onClick={() => quickClose(p.id, p.title)}
                        className="px-3 py-1.5 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50">
                        ปิดรับ
                      </button>
                    ) : (
                      <button type="button" disabled={busy}
                        onClick={() => quickOpen(p.id)}
                        className="px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-700 hover:bg-emerald-50">
                        เปิดรับ
                      </button>
                    )}
                    <button type="button" disabled={busy}
                      onClick={() => del(p.id, p.title)}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50">
                      ลบ
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>

      {/* New position dialog */}
      {showNew && (
        <NewPositionDialog
          branches={branches}
          personaTitles={personaTitles}
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            router.push(`/admin/recruita/positions/${id}`);
          }}
        />
      )}
    </div>
  );
}

function NewPositionDialog({
  branches, personaTitles, onClose, onCreated
}: {
  branches: Branch[];
  personaTitles: PersonaTitle[];
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [code, setCode] = useState("");
  const [branchId, setBranchId] = useState<string>("");
  const [employmentType, setEmploymentType] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    setErr(null);
    if (!title.trim()) { setErr("กรุณาใส่ชื่อตำแหน่ง"); return; }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/recruita/positions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          code: code.trim() || null,
          branch_id: branchId ? Number(branchId) : null,
          employment_type: employmentType || null,
          status: "draft"
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? "สร้างไม่สำเร็จ"); return; }
      onCreated(Number(j.id));
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800 text-lg">ตำแหน่งงานใหม่</h3>
        <p className="text-xs text-slate-500">
          สร้างเป็น "ร่าง" ก่อน — ใส่ JD/คำถามได้ในหน้าแก้ไข เปิดรับเมื่อพร้อม
        </p>
        <div>
          <label className="label flex items-center justify-between">
            <span>ชื่อตำแหน่ง *</span>
            {title.trim() && (
              isExistingPersonaTitle(title, personaTitles) ? (
                <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                  ✓ มีใน PERSONA
                </span>
              ) : (
                <span className="text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                  ใหม่ — ไม่มีใน PERSONA
                </span>
              )
            )}
          </label>
          <input className="input" value={title}
            list="recruita-persona-titles"
            onChange={(e) => setTitle(e.target.value)}
            placeholder="เลือกจากตำแหน่งที่มีอยู่ใน PERSONA หรือพิมพ์ใหม่" />
          {personaTitles.length > 0 && (
            <datalist id="recruita-persona-titles">
              {personaTitles.map((p) => (
                <option key={p.title} value={p.title}>
                  {p.description ? `— ${p.description}` : ""}
                </option>
              ))}
            </datalist>
          )}
          <p className="text-[10px] text-slate-400 mt-1">
            💡 พิมพ์เพื่อค้นหาตำแหน่งใน PERSONA · หรือพิมพ์ตำแหน่งใหม่ที่ยังไม่เคยมี
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">รหัส (ไม่บังคับ)</label>
            <input className="input uppercase tracking-wide font-bold"
              value={code} maxLength={20}
              onChange={(e) => setCode(e.target.value)}
              placeholder="RN-PT" />
          </div>
          <div>
            <label className="label">รูปแบบงาน</label>
            <select className="input" value={employmentType}
              onChange={(e) => setEmploymentType(e.target.value)}>
              <option value="">—</option>
              <option value="ft">พนักงานประจำ</option>
              <option value="pt">พนักงานพาร์ทไทม์</option>
              <option value="contract">พนักงานสัญญาจ้างระยะสั้น</option>
            </select>
          </div>
        </div>
        <div>
          <label className="label">สาขา</label>
          <select className="input" value={branchId}
            onChange={(e) => setBranchId(e.target.value)}>
            <option value="">— ทุกสาขา —</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        {err && <div className="text-rose-600 text-sm">{err}</div>}
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy}
            className="flex-1 py-2 rounded-lg border border-slate-300 text-slate-700">
            ยกเลิก
          </button>
          <button type="button" onClick={create} disabled={busy || !title.trim()}
            className="flex-1 py-2 rounded-lg bg-brand text-white font-bold disabled:opacity-50">
            {busy ? "กำลังสร้าง…" : "สร้างเป็นร่าง"}
          </button>
        </div>
      </div>
    </div>
  );
}
