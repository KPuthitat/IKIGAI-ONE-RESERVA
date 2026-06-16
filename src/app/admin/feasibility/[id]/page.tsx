import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getProject } from "@/lib/feasibility-db";
import { listItems } from "@/lib/feasibility-startup-db";
import ProjectEditor from "./ProjectEditor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "FEASIBILITY · โปรเจค" };

export default function FeasibilityProjectPage({ params }: { params: { id: string } }) {
  const user = requireAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const project = getProject(id, user.id);
  if (!project) notFound();

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/feasibility" className="text-sm text-slate-500 hover:text-brand">
          ← กลับรายการโปรเจค
        </Link>
      </div>
      <ProjectEditor
        id={project.id}
        meta={{
          company: project.company,
          project_name: project.project_name,
          location: project.location ?? "",
          business_type: project.business_type ?? "",
          status: project.status
        }}
        inputs={project.inputs}
        startupItems={listItems(project.id, user.id).map((it) => ({
          id: it.id,
          category: it.category,
          paid_date: it.paid_date,
          item_name: it.item_name,
          payee: it.payee,
          amount: it.amount,
          wht_mode: it.wht_mode,
          wht_value: it.wht_value,
          doc_type: it.doc_type,
          payment_status: it.payment_status
        }))}
      />
    </div>
  );
}
