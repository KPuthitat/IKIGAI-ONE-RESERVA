// /admin/inbox/branch/[id] — the customer inbox for ONE branch (owner 2026-10-06:
// ทำหน้า Inbox แยกตามสาขา). Same screen as /admin/inbox, but the list, the polling
// and the header are fixed to the branch, so a branch team can bookmark its own
// page. Access follows the main inbox: super_admin, or an admin of that branch.

import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listConversations, inboxScopeFor } from "@/lib/inbox";
import InboxClient from "../../InboxClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "กล่องข้อความลูกค้า · สาขา" };

export default function AdminBranchInboxPage({ params }: { params: { id: string } }) {
  const user = requireAdmin();
  const id = Number(params.id);
  const branch = Number.isInteger(id) && id > 0
    ? (getDb().prepare("SELECT id, name FROM branches WHERE id = ?").get(id) as { id: number; name: string } | undefined)
    : undefined;
  const { scope, hasAccess } = inboxScopeFor(user);
  const allowed = !!branch && hasAccess && (scope == null || scope.includes(branch.id));
  if (!branch || !allowed) {
    return (
      <div className="space-y-3">
        <Link href="/admin/inbox" className="text-sm text-slate-500 hover:text-brand">← กล่องข้อความลูกค้า</Link>
        <div className="card text-sm text-slate-500">
          ไม่พบสาขานี้ หรือบัญชีนี้ไม่มีสิทธิ์ดูแลสาขานี้
        </div>
      </div>
    );
  }
  return (
    <InboxClient
      initialConversations={listConversations({ branchIds: [branch.id] })}
      hasAccess
      branch={{ id: branch.id, name: branch.name }}
    />
  );
}
