// ── ACCOUNTA — Google Drive receipt sync (server-only, OAuth) ──────────
//
// When a bill is CONFIRMED, its receipt uploads to that BRANCH's own Google
// Drive, foldered by bill month (YYYY-MM). Each branch authorises its own
// Google account once (OAuth) — the app then uploads AS that user, so files
// land in the branch's Drive and use the branch's 15 GB quota.
//
// Why OAuth and not a service account: service accounts have NO Drive storage
// quota on consumer Gmail, so SA-owned uploads fail with storageQuotaExceeded
// (owner 2026-06-20 — confirmed in prod). OAuth uploads are owned by the user,
// sidestepping the quota entirely.
//
// Scope is `drive.file` (non-sensitive — no Google app verification needed):
// the app creates its OWN root folder + month subfolders + files, so it never
// needs access to the user's other files. The app-level OAuth client lives in
// env (GOOGLE_OAUTH_CLIENT_ID / _SECRET); the per-branch refresh token is
// stored encrypted. All sync is BEST-EFFORT and never throws.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { getDb } from "./db";
import { encryptSecret, decryptSecret } from "./secret-vault";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SCOPES = "openid email https://www.googleapis.com/auth/drive.file";
const ROOT_FOLDER_NAME = "ACCOUNTA - บิลค่าใช้จ่าย";

const FETCH_TIMEOUT_MS = 20_000;
function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

const clientId = () => process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const clientSecret = () => process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const baseUrl = () => (process.env.APP_BASE_URL || "https://ikigaimedihealth.com").replace(/\/$/, "");
const redirectUri = () => `${baseUrl()}/api/accounta/drive/oauth/callback`;

/** True when the server-level OAuth client is configured. */
export function driveOAuthConfigured(): boolean {
  return !!clientId() && !!clientSecret();
}

export type DriveConfig = {
  branch_id: number;
  enabled: number;
  oauth_refresh_token_enc: string | null;
  oauth_email: string | null;
  oauth_root_folder_id: string | null;
  last_ok_at: string | null;
  last_error: string | null;
};

export function getDriveConfig(branchId: number): DriveConfig | undefined {
  return getDb().prepare(
    "SELECT branch_id, enabled, oauth_refresh_token_enc, oauth_email, oauth_root_folder_id, last_ok_at, last_error FROM accounta_drive_config WHERE branch_id = ?"
  ).get(branchId) as DriveConfig | undefined;
}

/** All branch configs joined with the branch name — for the admin list. */
export function listDriveConfigs(): Array<{
  branch_id: number; branch_name: string; company_name: string | null;
  enabled: number; connected: number; oauth_email: string | null;
  last_ok_at: string | null; last_error: string | null;
}> {
  return getDb().prepare(`
    SELECT b.id AS branch_id, b.name AS branch_name, co.name_th AS company_name,
           COALESCE(d.enabled, 0) AS enabled,
           CASE WHEN d.oauth_refresh_token_enc IS NOT NULL THEN 1 ELSE 0 END AS connected,
           d.oauth_email, d.last_ok_at, d.last_error
    FROM branches b
    LEFT JOIN accounta_drive_config d ON d.branch_id = b.id
    LEFT JOIN companies co ON co.id = b.company_id
    ORDER BY co.name_th, b.name
  `).all() as Array<{
    branch_id: number; branch_name: string; company_name: string | null;
    enabled: number; connected: number; oauth_email: string | null;
    last_ok_at: string | null; last_error: string | null;
  }>;
}

/** Toggle the enabled flag (connection is managed by the OAuth flow). */
export function setDriveEnabled(branchId: number, enabled: boolean, updatedBy: number): void {
  const db = getDb();
  const existing = getDriveConfig(branchId);
  if (existing) {
    db.prepare("UPDATE accounta_drive_config SET enabled = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE branch_id = ?")
      .run(enabled ? 1 : 0, updatedBy, branchId);
  } else {
    db.prepare("INSERT INTO accounta_drive_config (branch_id, enabled, updated_by) VALUES (?, ?, ?)")
      .run(branchId, enabled ? 1 : 0, updatedBy);
  }
}

/** Forget a branch's Google connection (refresh token + cached state). */
export function disconnectDrive(branchId: number, updatedBy: number): void {
  getDb().prepare(`
    UPDATE accounta_drive_config
    SET oauth_refresh_token_enc = NULL, oauth_email = NULL, oauth_root_folder_id = NULL,
        enabled = 0, last_error = NULL, updated_at = CURRENT_TIMESTAMP, updated_by = ?
    WHERE branch_id = ?
  `).run(updatedBy, branchId);
  tokenCache.delete(branchId);
}

function setStatus(branchId: number, s: { ok: boolean; error?: string }): void {
  if (s.ok) {
    getDb().prepare("UPDATE accounta_drive_config SET last_ok_at = CURRENT_TIMESTAMP, last_error = NULL WHERE branch_id = ?").run(branchId);
  } else {
    getDb().prepare("UPDATE accounta_drive_config SET last_error = ? WHERE branch_id = ?").run((s.error ?? "unknown").slice(0, 400), branchId);
  }
}

// ── OAuth flow ─────────────────────────────────────────────────────────

function stateSecret(): string {
  return process.env.RESERVA_SECRET_KEY || "accounta-drive-state";
}
/** Signed, time-boxed state carrying the branch id (CSRF protection). */
function signState(branchId: number): string {
  const payload = `${branchId}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", stateSecret()).update(payload).digest("hex").slice(0, 32);
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}
export function verifyState(state: string): number | null {
  try {
    const raw = Buffer.from(state, "base64url").toString("utf8");
    const [branchId, ts, sig] = raw.split(".");
    const expect = crypto.createHmac("sha256", stateSecret()).update(`${branchId}.${ts}`).digest("hex").slice(0, 32);
    if (!sig || sig !== expect) return null;
    if (Date.now() - Number(ts) > 15 * 60 * 1000) return null; // 15-min window
    const id = Number(branchId);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch { return null; }
}

/** Google consent URL for connecting a branch's Drive. */
export function buildDriveAuthUrl(branchId: number): string {
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",            // force a refresh_token every time
    include_granted_scopes: "true",
    state: signState(branchId)
  });
  return `${AUTH_URL}?${p.toString()}`;
}

function decodeEmail(idToken: string | undefined): string {
  if (!idToken) return "";
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString("utf8")) as { email?: string };
    return payload.email || "";
  } catch { return ""; }
}

/** Exchange the auth code for a refresh token + connected email, then store
 *  it (encrypted) on the branch config + enable sync. */
export async function completeDriveOAuth(branchId: number, code: string, updatedBy: number): Promise<{ ok: boolean; email?: string; error?: string }> {
  if (!driveOAuthConfigured()) return { ok: false, error: "เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า GOOGLE_OAUTH_CLIENT_ID / SECRET" };
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: clientId(), client_secret: clientSecret(),
        redirect_uri: redirectUri(), grant_type: "authorization_code"
      }),
      signal: timeoutSignal()
    });
    const j = await res.json().catch(() => ({})) as { refresh_token?: string; id_token?: string; error_description?: string; error?: string };
    if (!res.ok || !j.refresh_token) {
      throw new Error(j.error_description || j.error || "ไม่ได้ refresh token (ลองถอดสิทธิ์แอปออกจากบัญชี Google แล้วเชื่อมใหม่)");
    }
    const email = decodeEmail(j.id_token);
    const enc = encryptSecret(j.refresh_token);
    const db = getDb();
    const existing = getDriveConfig(branchId);
    if (existing) {
      db.prepare(`
        UPDATE accounta_drive_config
        SET oauth_refresh_token_enc = ?, oauth_email = ?, oauth_root_folder_id = NULL,
            enabled = 1, last_error = NULL, updated_at = CURRENT_TIMESTAMP, updated_by = ?
        WHERE branch_id = ?
      `).run(enc, email, updatedBy, branchId);
    } else {
      db.prepare(`
        INSERT INTO accounta_drive_config (branch_id, enabled, oauth_refresh_token_enc, oauth_email, updated_by)
        VALUES (?, 1, ?, ?, ?)
      `).run(branchId, enc, email, updatedBy);
    }
    tokenCache.delete(branchId);
    return { ok: true, email };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Short-lived access-token cache keyed by branch id.
const tokenCache = new Map<number, { token: string; exp: number }>();

async function getAccessToken(branchId: number, refreshToken: string): Promise<string> {
  const cached = tokenCache.get(branchId);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(), client_secret: clientSecret(),
      refresh_token: refreshToken, grant_type: "refresh_token"
    }),
    signal: timeoutSignal()
  });
  const j = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !j.access_token) throw new Error(`refresh: ${j.error_description || res.status}`);
  tokenCache.set(branchId, { token: j.access_token, exp: now + (j.expires_in ?? 3600) });
  return j.access_token;
}

/** The app's own root folder in the user's Drive (auto-created once). */
async function ensureRootFolder(branchId: number, token: string): Promise<string> {
  const cfg = getDriveConfig(branchId);
  if (cfg?.oauth_root_folder_id) return cfg.oauth_root_folder_id;
  const cr = await fetch(`${DRIVE_API}?fields=id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: ROOT_FOLDER_NAME, mimeType: FOLDER_MIME }),
    signal: timeoutSignal()
  });
  const cj = await cr.json().catch(() => ({})) as { id?: string; error?: { message: string } };
  if (!cr.ok || !cj.id) throw new Error(`create root: ${cj.error?.message || cr.status}`);
  getDb().prepare("UPDATE accounta_drive_config SET oauth_root_folder_id = ? WHERE branch_id = ?").run(cj.id, branchId);
  return cj.id;
}

/** Find (or create) the YYYY-MM subfolder under rootId; returns its id. */
async function ensureMonthFolder(token: string, rootId: string, month: string): Promise<string> {
  const q = `name='${month}' and '${rootId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`;
  const findUrl = `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)`;
  const fr = await fetch(findUrl, { headers: { Authorization: `Bearer ${token}` }, signal: timeoutSignal() });
  const fj = await fr.json().catch(() => ({})) as { files?: Array<{ id: string }>; error?: { message: string } };
  if (!fr.ok) throw new Error(`find folder: ${fj.error?.message || fr.status}`);
  if (fj.files && fj.files.length > 0) return fj.files[0].id;

  const cr = await fetch(`${DRIVE_API}?fields=id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: month, mimeType: FOLDER_MIME, parents: [rootId] }),
    signal: timeoutSignal()
  });
  const cj = await cr.json().catch(() => ({})) as { id?: string; error?: { message: string } };
  if (!cr.ok || !cj.id) throw new Error(`create folder: ${cj.error?.message || cr.status}`);
  return cj.id;
}

/** Multipart upload of a file buffer into a folder; returns the file id. */
async function uploadMultipart(token: string, folderId: string, name: string, mime: string, data: Buffer): Promise<string> {
  const boundary = "ikigai_" + crypto.randomBytes(8).toString("hex");
  const meta = JSON.stringify({ name, parents: [folderId] });
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, "utf8"
  );
  const post = Buffer.from(`\r\n--${boundary}--`, "utf8");
  const body = Buffer.concat([pre, data, post]);

  const res = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: new Uint8Array(body),
    signal: timeoutSignal()
  });
  const json = await res.json().catch(() => ({})) as { id?: string; error?: { message: string } };
  if (!res.ok || !json.id) throw new Error(`upload: ${json.error?.message || res.status}`);
  return json.id;
}

function extForMime(mime: string | null): string {
  switch (mime) {
    case "application/pdf": return ".pdf";
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    default: return ".jpg";
  }
}

/** Verify a branch's connection end-to-end (token refresh + root folder)
 *  without uploading a real bill — drives the admin "ทดสอบ" button. */
export async function testDriveConfig(branchId: number): Promise<{ ok: boolean; error?: string }> {
  const cfg = getDriveConfig(branchId);
  if (!cfg?.oauth_refresh_token_enc) return { ok: false, error: "ยังไม่ได้เชื่อมต่อ Google Drive" };
  if (!driveOAuthConfigured()) return { ok: false, error: "เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า GOOGLE_OAUTH_CLIENT_ID / SECRET" };
  try {
    const rt = decryptSecret(cfg.oauth_refresh_token_enc);
    if (!rt) throw new Error("ถอดรหัส token ไม่สำเร็จ — RESERVA_SECRET_KEY อาจไม่ตรง");
    const token = await getAccessToken(branchId, rt);
    await ensureRootFolder(branchId, token);
    getDb().prepare("UPDATE accounta_drive_config SET last_error = NULL WHERE branch_id = ?").run(branchId);
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setStatus(branchId, { ok: false, error });
    return { ok: false, error };
  }
}

/** Best-effort: upload a confirmed bill's receipt to its branch Drive,
 *  foldered by bill month. No-op (never throws) when the bill isn't
 *  confirmed, has no receipt, was already synced, or the branch isn't
 *  connected / enabled. */
export async function syncReceiptToDrive(expenseId: number): Promise<void> {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, branch_id, bill_date, review_status, doc_path, doc_mime, drive_file_id
    FROM accounta_expenses WHERE id = ?
  `).get(expenseId) as {
    id: number; branch_id: number | null; bill_date: string | null;
    review_status: string; doc_path: string | null; doc_mime: string | null;
    drive_file_id: string | null;
  } | undefined;

  if (!row || row.review_status !== "confirmed" || row.branch_id == null) return;

  // Primary receipt (on the expense) + any extra attachments not yet synced.
  const primaryNeedsUpload = !!row.doc_path && !row.drive_file_id;
  const extras = db.prepare(
    "SELECT id, doc_path, doc_mime FROM accounta_expense_docs WHERE expense_id = ? AND drive_file_id IS NULL"
  ).all(row.id) as Array<{ id: number; doc_path: string; doc_mime: string | null }>;
  if (!primaryNeedsUpload && extras.length === 0) return;

  const cfg = getDriveConfig(row.branch_id);
  if (!cfg?.enabled || !cfg.oauth_refresh_token_enc) return;
  if (!driveOAuthConfigured()) { setStatus(row.branch_id, { ok: false, error: "server OAuth not configured" }); return; }

  try {
    const rt = decryptSecret(cfg.oauth_refresh_token_enc);
    if (!rt) throw new Error("ถอดรหัส refresh token ไม่สำเร็จ — RESERVA_SECRET_KEY อาจไม่ตรง");
    const token = await getAccessToken(row.branch_id, rt);
    const root = await ensureRootFolder(row.branch_id, token);
    const month = (row.bill_date || "").slice(0, 7) || "ไม่ระบุเดือน";
    const folderId = await ensureMonthFolder(token, root, month);

    if (primaryNeedsUpload && row.doc_path) {
      const buf = await fs.readFile(row.doc_path);
      const name = `${row.bill_date || "nodate"}-bill${row.id}${extForMime(row.doc_mime)}`;
      const fileId = await uploadMultipart(token, folderId, name, row.doc_mime || "application/octet-stream", buf);
      db.prepare("UPDATE accounta_expenses SET drive_file_id = ? WHERE id = ?").run(fileId, row.id);
    }
    for (const ex of extras) {
      const buf = await fs.readFile(ex.doc_path);
      const name = `${row.bill_date || "nodate"}-bill${row.id}-add${ex.id}${extForMime(ex.doc_mime)}`;
      const fileId = await uploadMultipart(token, folderId, name, ex.doc_mime || "application/octet-stream", buf);
      db.prepare("UPDATE accounta_expense_docs SET drive_file_id = ? WHERE id = ?").run(fileId, ex.id);
    }
    setStatus(row.branch_id, { ok: true });
  } catch (e) {
    setStatus(row.branch_id, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
