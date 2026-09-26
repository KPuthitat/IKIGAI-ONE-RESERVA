import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import {
  listConversations,
  getThread,
  markRead,
  sendReply,
  unreadCount,
  inboxScopeFor
} from "@/lib/inbox";

// Unified customer-chat inbox — back office (owner 2026-09-26). Staff read and
// reply to LINE OA messages from one screen (น้องฮูก is the entry point).
//
//   GET  /api/admin/inbox        → conversation list + unread count
//   GET  /api/admin/inbox?id=N   → one thread (and marks it read)
//   GET  /api/admin/inbox?count=1→ unread count only (for the owl badge)
//   POST /api/admin/inbox        → { action: 'reply' | 'read', id, text? }
//
// Every read/write is scoped to the viewer's branches: super_admin sees all
// OAs, a branch-admin only their own. An admin with no admin-branches sees
// nothing (customer chat is inherently per branch).

export const dynamic = "force-dynamic";

/** The branch scope for this viewer, and whether they have any access at all.
 *  scope=null → every branch (super_admin). scope=[] with hasAccess=false →
 *  a non-super admin with no admin-branches: show nothing rather than leak. */
const scopeFor = inboxScopeFor;

export function GET(req: Request) {
  const user = requireAdmin();
  const { scope, hasAccess } = scopeFor(user);
  const sp = new URL(req.url).searchParams;

  if (sp.get("count") != null) {
    return NextResponse.json({ ok: true, unread: hasAccess ? unreadCount(scope) : 0 });
  }

  const idRaw = sp.get("id");
  if (idRaw != null) {
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "bad_id" }, { status: 400 });
    }
    if (!hasAccess) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const thread = getThread(id, scope);
    if (!thread.conversation) return NextResponse.json({ error: "not_found" }, { status: 404 });
    markRead(id, scope);
    return NextResponse.json({ ok: true, ...thread });
  }

  if (!hasAccess) return NextResponse.json({ ok: true, conversations: [], unread: 0 });
  const status = sp.get("status") === "all" ? "all" : "open";
  return NextResponse.json({
    ok: true,
    conversations: listConversations({ branchIds: scope, status }),
    unread: unreadCount(scope)
  });
}

const Body = z.object({
  action: z.enum(["reply", "read"]),
  id: z.number().int().positive(),
  text: z.string().max(4000).optional()
});

export async function POST(req: Request) {
  const user = requireAdmin();
  const { scope, hasAccess } = scopeFor(user);
  if (!hasAccess) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { action, id, text } = parsed.data;

  if (action === "read") {
    markRead(id, scope);
    return NextResponse.json({ ok: true });
  }

  // action === "reply"
  const result = await sendReply(id, user.id, text ?? "", scope);
  if (result !== "sent") {
    const status = result === "no_conversation" ? 404 : result === "empty" ? 400 : 502;
    return NextResponse.json({ ok: false, result }, { status });
  }
  return NextResponse.json({ ok: true, result });
}
