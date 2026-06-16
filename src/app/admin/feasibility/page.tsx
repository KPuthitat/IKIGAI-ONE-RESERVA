import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { listProjects } from "@/lib/feasibility-db";
import FeasibilityClient from "./FeasibilityClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "FEASIBILITY · IKIGAI OS" };

// FEASIBILITY — project investment feasibility. Admin/executive only
// (requireAdmin); each admin sees only their own projects (scoped in
// listProjects by created_by).
export default function FeasibilityListPage() {
  const user = requireAdmin();
  const projects = listProjects(user.id);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin" className="text-sm text-slate-500 hover:text-brand">
          ← กลับหน้ารวมโมดูล
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">FEASIBILITY</h1>
        <p className="text-sm text-slate-500 mt-1">
          ประเมินความเป็นไปได้ของโปรเจคลงทุน — &quot;คุ้มทำหรือไม่&quot; และหาช่วงรายได้ที่เหมาะสม
        </p>
      </div>
      <FeasibilityClient
        projects={projects.map((p) => ({
          id: p.id,
          company: p.company,
          project_name: p.project_name,
          location: p.location,
          status: p.status,
          updated_at: p.updated_at,
          summary: p.summary
        }))}
      />
    </div>
  );
}
