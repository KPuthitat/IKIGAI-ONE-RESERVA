import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { getProject, listCompanies } from "@/lib/feasibility-db";
import { listItems } from "@/lib/feasibility-startup-db";
import { listBranches, listCapexForFeasibility } from "@/lib/accounta-db";
import ProjectEditor, { type AccountaCapex } from "./ProjectEditor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "FEASIBILITY · โปรเจค" };

export default function FeasibilityProjectPage({ params }: { params: { id: string } }) {
  const user = requirePermission("accounta.manage");
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const project = getProject(id, user.id);
  if (!project) notFound();

  // Live CapEx pulled from ACCOUNTA — confirmed bills tagged with a feasibility
  // bucket for this project's linked branch, grouped per bucket (owner 2026-06-29).
  const accountaCapex: AccountaCapex = {};
  if (project.branch_id != null) {
    for (const l of listCapexForFeasibility(project.branch_id)) {
      const g = (accountaCapex[l.bucket] ??= { sum: 0, lines: [] });
      g.sum += l.amount;
      g.lines.push({ id: l.id, bill_date: l.bill_date, payee: l.payee, amount: l.amount, payment_status: l.payment_status, has_doc: l.has_doc });
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/accounta/feasibility" className="text-sm text-slate-500 hover:text-brand">
          ← กลับรายการโปรเจค
        </Link>
      </div>
      <ProjectEditor
        id={project.id}
        companies={listCompanies()}
        branches={listBranches().map((b) => ({ id: b.id, name: b.name }))}
        accountaCapex={accountaCapex}
        meta={{
          company: project.company,
          project_name: project.project_name,
          location: project.location ?? "",
          business_type: project.business_type ?? "",
          branch_id: project.branch_id,
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
