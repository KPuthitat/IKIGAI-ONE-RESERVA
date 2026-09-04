import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getDocument, effectiveVersion, ackStatus, QUALITY_TYPE_LABEL } from "@/lib/quality-docs";
import QualityDocClient from "./QualityDocClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "เอกสารคุณภาพ · PERSONA" };

export default function QualityDocDetailPage({ params }: { params: { id: string } }) {
  requirePermission("quality.manage");
  const db = getDb();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const got = getDocument(db, id);
  if (!got) notFound();

  const eff = effectiveVersion(db, id);
  const acks = eff ? ackStatus(db, eff.id) : null;
  const owner = got.doc.owner_user_id
    ? (db.prepare("SELECT display_name FROM users WHERE id = ?").get(got.doc.owner_user_id) as { display_name: string } | undefined)?.display_name ?? null
    : null;
  const branchName = got.doc.branch_id
    ? (db.prepare("SELECT name FROM branches WHERE id = ?").get(got.doc.branch_id) as { name: string } | undefined)?.name ?? null
    : null;

  return (
    <div className="space-y-4">
      <Link href="/admin/persona/quality" className="text-xs text-brand hover:underline">← กลับรายการเอกสาร</Link>
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-slate-500">{got.doc.doc_code}</span>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{QUALITY_TYPE_LABEL[got.doc.doc_type]}</span>
          <span className="text-[11px] text-slate-400">{branchName ?? "ทุกสาขา"}{owner ? ` · ผู้รับผิดชอบ ${owner}` : ""}</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-800 mt-1">{got.doc.title}</h1>
      </div>
      <QualityDocClient
        documentId={id}
        versions={got.versions}
        effectiveVersionId={eff?.id ?? null}
        ack={acks ? { total: acks.total, acked: acks.acked, pending: acks.pendingUsers } : null}
      />
    </div>
  );
}
