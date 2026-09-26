// /admin/inbox — unified customer-chat inbox back office (owner 2026-09-26).
//
// น้องฮูก as one reply point for every channel. Phase 1: LINE OA per branch,
// human reply. Inbound messages captured by the LINE webhook (PR1) land here;
// staff read a thread and reply, and the reply goes back out over that OA.
//
// Scope: super_admin sees every branch's chats; a branch-admin only their own.
// Read data renders server-side for the first paint; the client island then
// polls for new messages and drives the reply box.

import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { listConversations } from "@/lib/inbox";
import InboxClient from "./InboxClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "กล่องข้อความลูกค้า · Inbox" };

export default function AdminInboxPage() {
  const user = requireAdmin();
  const scope = user.role === "super_admin" ? null : user.adminBranchIds;
  const hasAccess = user.role === "super_admin" || user.adminBranchIds.length > 0;
  const conversations = hasAccess ? listConversations({ branchIds: scope }) : [];
  return <InboxClient initialConversations={conversations} hasAccess={hasAccess} />;
}
