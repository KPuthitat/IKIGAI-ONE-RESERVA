// Facebook Messenger channel (owner 2026-09-29). A connected Page's Messenger
// chats land in the same น้องฮูก inbox as LINE. This module holds the config
// (encrypted tokens), the webhook signature check, and the Send API reply.
//
// Network calls run on the prod droplet (the sandbox can't reach graph.facebook.com,
// same as the weather API) — best-effort, never throw into the webhook ack.

import crypto from "node:crypto";
import { getDb } from "./db";
import { encryptSecret, decryptSecret } from "./secret-vault";

const GRAPH = "https://graph.facebook.com/v21.0";

export type FacebookChannel = {
  id: number;
  page_id: string;
  page_name: string | null;
  access_token: string | null;   // decrypted (plaintext) — Page access token for the Send API
  app_secret: string | null;     // decrypted — App secret for webhook signature verification
  verify_token: string | null;
  branch_id: number | null;
};

type Row = {
  id: number; page_id: string; page_name: string | null;
  access_token: string | null; app_secret: string | null;
  verify_token: string | null; branch_id: number | null;
};

function hydrate(r: Row): FacebookChannel {
  return { ...r, access_token: decryptSecret(r.access_token), app_secret: decryptSecret(r.app_secret) };
}

/** The connected Page by its id (the webhook channel_code), with tokens decrypted. */
export function getFacebookChannel(pageId: string): FacebookChannel | null {
  const r = getDb().prepare(
    "SELECT id, page_id, page_name, access_token, app_secret, verify_token, branch_id FROM facebook_channels WHERE page_id = ?"
  ).get(pageId) as Row | undefined;
  return r ? hydrate(r) : null;
}

/** The Page whose stored verify_token matches (webhook GET handshake). null if
 *  none — the handshake is app-level, so any configured Page's token is accepted. */
export function findFacebookChannelByVerifyToken(token: string): FacebookChannel | null {
  if (!token) return null;
  const r = getDb().prepare(
    "SELECT id, page_id, page_name, access_token, app_secret, verify_token, branch_id FROM facebook_channels WHERE verify_token = ?"
  ).get(token) as Row | undefined;
  return r ? hydrate(r) : null;
}

/** All connected Pages (admin listing). Tokens decrypted. */
export function listFacebookChannels(): FacebookChannel[] {
  return (getDb().prepare(
    "SELECT id, page_id, page_name, access_token, app_secret, verify_token, branch_id FROM facebook_channels ORDER BY id"
  ).all() as Row[]).map(hydrate);
}

/** Upsert a Page's config. A token field left undefined KEEPS the stored value —
 *  so the admin form can re-save without re-pasting secrets (they're never sent
 *  back to the browser). Tokens are encrypted at rest. */
export function setFacebookChannel(args: {
  pageId: string;
  pageName?: string | null;
  accessToken?: string | null;   // undefined = keep; "" = clear; string = set
  appSecret?: string | null;     //   (same convention for all three secrets)
  verifyToken?: string | null;
  branchId?: number | null;
  updatedBy: number;
}): void {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM facebook_channels WHERE page_id = ?").get(args.pageId) as { id: number } | undefined;
  const encTok = args.accessToken === undefined ? undefined : encryptSecret(args.accessToken);
  const encSec = args.appSecret === undefined ? undefined : encryptSecret(args.appSecret);
  const vTok = args.verifyToken;   // undefined = keep, string = set (a shared secret, treated like the tokens)
  if (existing) {
    db.prepare(`
      UPDATE facebook_channels SET
        page_name    = COALESCE(?, page_name),
        access_token = CASE WHEN ? = 1 THEN ? ELSE access_token END,
        app_secret   = CASE WHEN ? = 1 THEN ? ELSE app_secret END,
        verify_token = CASE WHEN ? = 1 THEN ? ELSE verify_token END,
        branch_id    = ?,
        updated_at   = datetime('now'), updated_by = ?
      WHERE page_id = ?`).run(
      args.pageName ?? null,
      encTok === undefined ? 0 : 1, encTok ?? null,
      encSec === undefined ? 0 : 1, encSec ?? null,
      vTok === undefined ? 0 : 1, vTok ?? null,
      args.branchId ?? null,
      args.updatedBy, args.pageId
    );
  } else {
    db.prepare(`
      INSERT INTO facebook_channels (page_id, page_name, access_token, app_secret, verify_token, branch_id, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      args.pageId, args.pageName ?? null, encTok ?? null, encSec ?? null,
      vTok ?? null, args.branchId ?? null, args.updatedBy
    );
  }
}

/** Verify Meta's X-Hub-Signature-256 header ("sha256=<hex>") over the raw body. */
export function verifyFbSignature(appSecret: string, rawBody: string, header: string | null): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Send a plain-text reply back to a Messenger user via the Send API. RESPONSE
 *  type covers replies inside the 24-hour window (a human reply usually is). */
export async function sendMessengerText(pageToken: string, recipientId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(pageToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_type: "RESPONSE", recipient: { id: recipientId }, message: { text } })
    });
    if (res.ok) return { ok: true };
    const j = await res.json().catch(() => ({}));
    return { ok: false, error: (j as { error?: { message?: string } })?.error?.message ?? `http_${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network" };
  }
}

/** Best-effort display name for a Messenger user (PSID). null on any failure. */
export async function getFbProfileName(pageToken: string, psid: string): Promise<string | null> {
  try {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(psid)}?fields=name&access_token=${encodeURIComponent(pageToken)}`);
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({})) as { name?: string };
    return j?.name ?? null;
  } catch {
    return null;
  }
}
