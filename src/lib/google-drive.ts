// ── ACCOUNTA — Google Drive receipt sync (server-only) ─────────────────
//
// When a bill is CONFIRMED, its receipt file is uploaded to that BRANCH's
// own Google Drive, foldered by the bill month (YYYY-MM from bill_date).
// Per-branch credentials (owner 2026-06-20, option A): each branch has its
// own service account whose JSON key is stored encrypted; the branch shares
// a destination folder in its Drive with that SA (root_folder_id).
//
// No SDK — talks to the Drive + OAuth REST endpoints with raw fetch + a
// node:crypto-signed JWT, to keep the 1 GB droplet lean (same philosophy as
// the OCR client). All sync is BEST-EFFORT: a failure never blocks the
// confirm action; the error is stashed on accounta_drive_config.last_error
// for the admin to see.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { getDb } from "./db";
import { encryptSecret, decryptSecret } from "./secret-vault";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SCOPE = "https://www.googleapis.com/auth/drive";

// Bound every Google call so a hung request can't stall the confirm action
// (sync is awaited inside the confirm/doc routes).
const FETCH_TIMEOUT_MS = 20_000;
function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

export type DriveConfig = {
  branch_id: number;
  enabled: number;
  sa_json_enc: string | null;
  sa_client_email: string | null;
  root_folder_id: string | null;
  last_ok_at: string | null;
  last_error: string | null;
};

export function getDriveConfig(branchId: number): DriveConfig | undefined {
  return getDb().prepare(
    "SELECT branch_id, enabled, sa_json_enc, sa_client_email, root_folder_id, last_ok_at, last_error FROM accounta_drive_config WHERE branch_id = ?"
  ).get(branchId) as DriveConfig | undefined;
}

/** All branch configs joined with the branch name — for the admin list. */
export function listDriveConfigs(): Array<DriveConfig & { branch_name: string; company_name: string | null }> {
  return getDb().prepare(`
    SELECT b.id AS branch_id, b.name AS branch_name, co.name_th AS company_name,
           COALESCE(d.enabled, 0) AS enabled, d.sa_client_email, d.root_folder_id,
           d.last_ok_at, d.last_error, d.sa_json_enc
    FROM branches b
    LEFT JOIN accounta_drive_config d ON d.branch_id = b.id
    LEFT JOIN companies co ON co.id = b.company_id
    ORDER BY co.name_th, b.name
  `).all() as Array<DriveConfig & { branch_name: string; company_name: string | null }>;
}

/** Upsert a branch's Drive config. `saJson` null = keep the stored key;
 *  "" = clear it. Parses client_email out of the JSON for display. */
export function setDriveConfig(args: {
  branchId: number;
  enabled: boolean;
  saJson: string | null;
  rootFolderId: string | null;
  updatedBy: number;
}): { ok: true } | { ok: false; error: string } {
  const db = getDb();
  let saEnc: string | null | undefined;
  let clientEmail: string | null | undefined;
  if (args.saJson === "") {
    saEnc = null; clientEmail = null;
  } else if (args.saJson != null) {
    let parsed: { client_email?: string; private_key?: string };
    try { parsed = JSON.parse(args.saJson); }
    catch { return { ok: false, error: "ไฟล์ service account ไม่ใช่ JSON ที่ถูกต้อง" }; }
    if (!parsed.client_email || !parsed.private_key) {
      return { ok: false, error: "JSON ต้องมี client_email และ private_key" };
    }
    saEnc = encryptSecret(args.saJson);
    clientEmail = parsed.client_email;
  }

  const existing = getDriveConfig(args.branchId);
  if (existing) {
    db.prepare(`
      UPDATE accounta_drive_config
      SET enabled = ?, root_folder_id = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
          ${saEnc !== undefined ? ", sa_json_enc = ?, sa_client_email = ?" : ""}
      WHERE branch_id = ?
    `).run(
      args.enabled ? 1 : 0, args.rootFolderId || null, args.updatedBy,
      ...(saEnc !== undefined ? [saEnc, clientEmail ?? null] : []),
      args.branchId
    );
  } else {
    db.prepare(`
      INSERT INTO accounta_drive_config
        (branch_id, enabled, sa_json_enc, sa_client_email, root_folder_id, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      args.branchId, args.enabled ? 1 : 0, saEnc ?? null, clientEmail ?? null,
      args.rootFolderId || null, args.updatedBy
    );
  }
  return { ok: true };
}

function setStatus(branchId: number, s: { ok: boolean; error?: string }): void {
  if (s.ok) {
    getDb().prepare(
      "UPDATE accounta_drive_config SET last_ok_at = CURRENT_TIMESTAMP, last_error = NULL WHERE branch_id = ?"
    ).run(branchId);
  } else {
    getDb().prepare(
      "UPDATE accounta_drive_config SET last_error = ? WHERE branch_id = ?"
    ).run((s.error ?? "unknown").slice(0, 400), branchId);
  }
}

// ── Google REST plumbing ───────────────────────────────────────────────

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Short-lived access-token cache keyed by service-account email.
const tokenCache = new Map<string, { token: string; exp: number }>();

async function getAccessToken(clientEmail: string, privateKeyPem: string): Promise<string> {
  const cached = tokenCache.get(clientEmail);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600
  }));
  const signingInput = `${header}.${claims}`;
  const signature = b64url(
    crypto.createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem)
  );
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    }),
    signal: timeoutSignal()
  });
  const json = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`oauth: ${json.error_description || res.status}`);
  }
  tokenCache.set(clientEmail, { token: json.access_token, exp: now + (json.expires_in ?? 3600) });
  return json.access_token;
}

/** Find (or create) the YYYY-MM subfolder under rootId; returns its id. */
async function ensureMonthFolder(token: string, rootId: string, month: string): Promise<string> {
  const q = `name='${month}' and '${rootId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`;
  const findUrl = `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const fr = await fetch(findUrl, { headers: { Authorization: `Bearer ${token}` }, signal: timeoutSignal() });
  const fj = await fr.json().catch(() => ({})) as { files?: Array<{ id: string }>; error?: { message: string } };
  if (!fr.ok) throw new Error(`find folder: ${fj.error?.message || fr.status}`);
  if (fj.files && fj.files.length > 0) return fj.files[0].id;

  const cr = await fetch(`${DRIVE_API}?supportsAllDrives=true`, {
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
async function uploadMultipart(
  token: string, folderId: string, name: string, mime: string, data: Buffer
): Promise<string> {
  const boundary = "ikigai_" + crypto.randomBytes(8).toString("hex");
  const meta = JSON.stringify({ name, parents: [folderId] });
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, "utf8"
  );
  const post = Buffer.from(`\r\n--${boundary}--`, "utf8");
  const body = Buffer.concat([pre, data, post]);

  const res = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`
    },
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

/** Verify a branch's config end-to-end (token + folder access) without
 *  uploading a real bill — drives the admin "ทดสอบการเชื่อมต่อ" button. */
export async function testDriveConfig(branchId: number): Promise<{ ok: boolean; error?: string }> {
  const cfg = getDriveConfig(branchId);
  if (!cfg?.sa_json_enc || !cfg.root_folder_id) {
    return { ok: false, error: "ยังไม่ได้ตั้งค่า service account หรือโฟลเดอร์ปลายทาง" };
  }
  try {
    const dec = decryptSecret(cfg.sa_json_enc);
    if (!dec) throw new Error("ถอดรหัส service account key ไม่สำเร็จ — RESERVA_SECRET_KEY อาจไม่ตรงกับตอนบันทึก");
    const sa = JSON.parse(dec) as { client_email: string; private_key: string };
    const token = await getAccessToken(sa.client_email, sa.private_key);
    // Touch the root folder to confirm the SA can see it.
    const r = await fetch(
      `${DRIVE_API}/${encodeURIComponent(cfg.root_folder_id)}?fields=id,name&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` }, signal: timeoutSignal() }
    );
    if (!r.ok) {
      const j = await r.json().catch(() => ({})) as { error?: { message: string } };
      throw new Error(`โฟลเดอร์เข้าไม่ได้: ${j.error?.message || r.status} — ตรวจว่าได้แชร์โฟลเดอร์ให้ ${sa.client_email} แล้ว`);
    }
    // A successful test only clears the error — it must NOT stamp
    // last_ok_at, which means "last real upload" in the admin UI.
    getDb().prepare("UPDATE accounta_drive_config SET last_error = NULL WHERE branch_id = ?").run(branchId);
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setStatus(branchId, { ok: false, error });
    return { ok: false, error };
  }
}

/** Best-effort: upload a confirmed bill's receipt to its branch Drive,
 *  foldered by bill month. No-op (and never throws) when the bill isn't
 *  confirmed, has no receipt, was already synced, or the branch has no
 *  enabled Drive config. */
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

  if (!row || row.review_status !== "confirmed" || !row.doc_path
      || row.drive_file_id || row.branch_id == null) return;

  const cfg = getDriveConfig(row.branch_id);
  if (!cfg?.enabled || !cfg.root_folder_id || !cfg.sa_json_enc) return;

  try {
    const dec = decryptSecret(cfg.sa_json_enc);
    if (!dec) throw new Error("ถอดรหัส service account key ไม่สำเร็จ — RESERVA_SECRET_KEY อาจไม่ตรงกับตอนบันทึก");
    const sa = JSON.parse(dec) as { client_email: string; private_key: string };
    const token = await getAccessToken(sa.client_email, sa.private_key);
    const month = (row.bill_date || "").slice(0, 7) || "ไม่ระบุเดือน";
    const folderId = await ensureMonthFolder(token, cfg.root_folder_id, month);
    const buf = await fs.readFile(row.doc_path);
    const name = `${row.bill_date || "nodate"}-bill${row.id}${extForMime(row.doc_mime)}`;
    const fileId = await uploadMultipart(token, folderId, name, row.doc_mime || "application/octet-stream", buf);
    db.prepare("UPDATE accounta_expenses SET drive_file_id = ? WHERE id = ?").run(fileId, row.id);
    setStatus(row.branch_id, { ok: true });
  } catch (e) {
    setStatus(row.branch_id, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
