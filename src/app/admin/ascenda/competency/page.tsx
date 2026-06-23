import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import {
  listAssessableUsers, listDimensions, listCatalog, ensureAssessment, getScores
} from "@/lib/competency-db";
import CompetencyClient from "./CompetencyClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ASCENDA · ประเมินสมรรถนะ" };

function currentQuarter(): string {
  const d = new Date(Date.now() + 7 * 3600_000);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

export default function CompetencyPage({ searchParams }: { searchParams: { user?: string; period?: string } }) {
  const me = requirePermission("ascenda.view");
  const users = listAssessableUsers();
  const userId = Number(searchParams.user) || null;
  const period = searchParams.period && /^\d{4}-Q[1-4]$/.test(searchParams.period) ? searchParams.period : currentQuarter();
  const dimensions = listDimensions();

  let initial: { assessmentId: number; track: string | null; status: "draft" | "final"; note: string | null; userName: string; scores: ReturnType<typeof getScores> } | null = null;
  if (userId && users.some((u) => u.id === userId)) {
    const a = ensureAssessment(userId, period, me.id, me.id);
    initial = { assessmentId: a.id, track: a.track, status: a.status, note: a.note, userName: a.user_name, scores: getScores(a.id) };
  }

  return (
    <div className="space-y-4">
      <Link href="/admin/ascenda" className="text-sm text-slate-500 hover:text-brand">← กลับ ASCENDA</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ประเมินสมรรถนะรายบุคคล</h1>
        <p className="text-sm text-slate-500 mt-1">ให้คะแนน 3 กลุ่ม (วิชาชีพ / soft / managing) → radar เทียบเป้า → เห็นจุดอ่อนเพื่อวางแผนพัฒนา</p>
        <p className="text-[11px] text-slate-400 mt-1">เฟส 1: ประเมิน + radar + จุดอ่อน · เฟสถัดไป: career path + แผนพัฒนา (IDP) ต่อระดับ</p>
      </div>
      <CompetencyClient
        users={users} userId={userId} period={period}
        dimensions={dimensions} catalog={listCatalog()} initial={initial}
      />
    </div>
  );
}
