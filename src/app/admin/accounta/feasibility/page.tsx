import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { listProjects, listCompanies } from "@/lib/feasibility-db";
import FeasibilityClient from "./FeasibilityClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "FEASIBILITY · IKIGAI OS" };

// FEASIBILITY — project investment feasibility, inside ACCOUNTA. Visible to
// every admin granted accounta.manage; projects are SHARED (not per-creator)
// so the team plans together.
export default function FeasibilityListPage() {
  requirePermission("accounta.manage");
  const projects = listProjects();
  const companies = listCompanies();

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ ACCOUNTA
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">FEASIBILITY</h1>
        <p className="text-sm text-slate-500 mt-1">
          ประเมินความเป็นไปได้ของโปรเจคลงทุน — &quot;คุ้มทำหรือไม่&quot; และหาช่วงรายได้ที่เหมาะสม
        </p>
      </div>
      <FeasibilityClient
        companies={companies}
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
