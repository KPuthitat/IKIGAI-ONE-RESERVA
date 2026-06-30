import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/feasibility-db";
import { listItems } from "@/lib/feasibility-startup-db";
import { listCapexForFeasibility } from "@/lib/accounta-db";
import ProjectEditor, { type AccountaCapex } from "./ProjectEditor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "FEASIBILITY · โปรเจค" };

export default function FeasibilityProjectPage({ params }: { params: { id: string } }) {
  const user = requirePermission("accounta.manage");
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const project = getProject(id, user.id);
  if (!project) notFound();

  // The project is locked to ONE branch (owner 2026-06-30): the branch it was
  // created for, else the admin's active branch. Company is derived from it — no
  // cross-branch / cross-company picker. CapEx is pulled from this same branch.
  const branchId = project.branch_id ?? user.activeBranchId ?? null;
  let branchName: string | null = null;
  let companyName = project.company;
  if (branchId != null) {
    const b = getDb().prepare(
      "SELECT b.name AS name, c.name_th AS company FROM branches b LEFT JOIN companies c ON c.id = b.company_id WHERE b.id = ?"
    ).get(branchId) as { name: string; company: string | null } | undefined;
    if (b) { branchName = b.name; companyName = b.company ?? project.company; }
  }

  const accountaCapex: AccountaCapex = {};
  if (branchId != null) {
    for (const l of listCapexForFeasibility(branchId)) {
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
        branchName={branchName}
        accountaCapex={accountaCapex}
        meta={{
          company: companyName,
          project_name: project.project_name,
          location: project.location ?? "",
          business_type: project.business_type ?? "",
          branch_id: branchId,
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
