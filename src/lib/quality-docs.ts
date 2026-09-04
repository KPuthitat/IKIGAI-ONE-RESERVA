// Quality document control (WI/WP) — server data layer. Owner 2026-09-04.
//
// ISO-style controlled documents:
//   quality_documents          — the master (stable doc_code, e.g. WI-001)
//   quality_document_versions  — revisions (draft → pending → approved → obsolete)
//   quality_document_acks      — per-version staff read acknowledgements
//
// Workflow: a หัวหน้า/แอดมิน (quality.manage) creates a document (rev 1, draft),
// edits the content/attachment, submits for approval (pending), an approver
// approves it (approved + effective; the previous approved rev goes obsolete) or
// rejects it back to draft. Staff read the effective version and กดรับทราบ.

import type Database from "better-sqlite3";

export type QualityDocType = "WI" | "WP";
export type QualityVersionStatus = "draft" | "pending" | "approved" | "obsolete" | "rejected";

export const QUALITY_DOC_TYPES: QualityDocType[] = ["WI", "WP"];
export const QUALITY_TYPE_LABEL: Record<QualityDocType, string> = {
  WI: "วิธีปฏิบัติงาน (WI)",
  WP: "ระเบียบปฏิบัติ (WP)"
};
export const QUALITY_STATUS_LABEL: Record<QualityVersionStatus, string> = {
  draft: "ร่าง",
  pending: "รออนุมัติ",
  approved: "อนุมัติ/มีผล",
  obsolete: "ยกเลิกใช้",
  rejected: "ตีกลับ"
};

export type QualityDocument = {
  id: number; doc_type: QualityDocType; doc_code: string; title: string;
  department: string | null; owner_user_id: number | null; branch_id: number | null;
  created_by: number | null; created_at: string; updated_at: string | null;
};
export type QualityVersion = {
  id: number; document_id: number; rev: number; status: QualityVersionStatus;
  content: string | null; file_path: string | null; file_name: string | null; file_mime: string | null;
  change_summary: string | null; effective_date: string | null;
  created_by: number | null; submitted_at: string | null;
  approved_by: number | null; approved_at: string | null; reject_reason: string | null;
  created_at: string; updated_at: string | null;
};

/** Next doc code for a type: WI-001, WP-002, … (max existing + 1, zero-padded). */
export function nextDocCode(db: Database.Database, docType: QualityDocType): string {
  const rows = db.prepare(
    "SELECT doc_code FROM quality_documents WHERE doc_type = ?"
  ).all(docType) as Array<{ doc_code: string }>;
  let max = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(r.doc_code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${docType}-${String(max + 1).padStart(3, "0")}`;
}

/** Create a document + its first draft revision. Returns the ids + code. */
export function createDocument(db: Database.Database, args: {
  docType: QualityDocType; title: string; department?: string | null;
  ownerUserId?: number | null; branchId?: number | null; createdBy: number;
  content?: string | null; filePath?: string | null; fileName?: string | null; fileMime?: string | null;
  changeSummary?: string | null; effectiveDate?: string | null;
}): { documentId: number; versionId: number; docCode: string } {
  return db.transaction(() => {
    const docCode = nextDocCode(db, args.docType);
    const doc = db.prepare(`
      INSERT INTO quality_documents (doc_type, doc_code, title, department, owner_user_id, branch_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(args.docType, docCode, args.title.trim(), args.department ?? null,
      args.ownerUserId ?? null, args.branchId ?? null, args.createdBy);
    const documentId = Number(doc.lastInsertRowid);
    const ver = db.prepare(`
      INSERT INTO quality_document_versions
        (document_id, rev, status, content, file_path, file_name, file_mime, change_summary, effective_date, created_by)
      VALUES (?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?)
    `).run(documentId, args.content ?? null, args.filePath ?? null, args.fileName ?? null,
      args.fileMime ?? null, args.changeSummary ?? null, args.effectiveDate ?? null, args.createdBy);
    return { documentId, versionId: Number(ver.lastInsertRowid), docCode };
  })();
}

/** Start a NEW revision of an existing document (draft). rev = max + 1. */
export function addRevision(db: Database.Database, documentId: number, args: {
  createdBy: number; content?: string | null; filePath?: string | null;
  fileName?: string | null; fileMime?: string | null; changeSummary?: string | null; effectiveDate?: string | null;
}): { versionId: number; rev: number } {
  const maxRev = (db.prepare("SELECT COALESCE(MAX(rev),0) AS m FROM quality_document_versions WHERE document_id = ?")
    .get(documentId) as { m: number }).m;
  const rev = maxRev + 1;
  const v = db.prepare(`
    INSERT INTO quality_document_versions
      (document_id, rev, status, content, file_path, file_name, file_mime, change_summary, effective_date, created_by)
    VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)
  `).run(documentId, rev, args.content ?? null, args.filePath ?? null, args.fileName ?? null,
    args.fileMime ?? null, args.changeSummary ?? null, args.effectiveDate ?? null, args.createdBy);
  return { versionId: Number(v.lastInsertRowid), rev };
}

/** Edit a DRAFT or REJECTED version's editable fields (owner-side). */
export function updateDraftVersion(db: Database.Database, versionId: number, patch: {
  content?: string | null; filePath?: string | null; fileName?: string | null; fileMime?: string | null;
  changeSummary?: string | null; effectiveDate?: string | null;
}): boolean {
  const v = db.prepare("SELECT status FROM quality_document_versions WHERE id = ?")
    .get(versionId) as { status: string } | undefined;
  if (!v || !["draft", "rejected"].includes(v.status)) return false;
  const sets: string[] = []; const vals: unknown[] = [];
  const put = (col: string, val: unknown) => { sets.push(`${col} = ?`); vals.push(val); };
  if ("content" in patch) put("content", patch.content ?? null);
  if ("filePath" in patch) { put("file_path", patch.filePath ?? null); }
  if ("fileName" in patch) put("file_name", patch.fileName ?? null);
  if ("fileMime" in patch) put("file_mime", patch.fileMime ?? null);
  if ("changeSummary" in patch) put("change_summary", patch.changeSummary ?? null);
  if ("effectiveDate" in patch) put("effective_date", patch.effectiveDate ?? null);
  if (sets.length === 0) return true;
  sets.push("updated_at = datetime('now')");
  vals.push(versionId);
  db.prepare(`UPDATE quality_document_versions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

/** Submit a draft/rejected version for approval → pending. */
export function submitVersion(db: Database.Database, versionId: number): boolean {
  const r = db.prepare(
    "UPDATE quality_document_versions SET status='pending', submitted_at=?, reject_reason=NULL, updated_at=datetime('now') WHERE id=? AND status IN ('draft','rejected')"
  ).run(new Date().toISOString(), versionId);
  return r.changes > 0;
}

/**
 * Approve a pending version → approved + effective. The previously-approved
 * version of the same document is superseded (→ obsolete). Atomic.
 */
export function approveVersion(db: Database.Database, versionId: number, approverId: number, effectiveDate?: string | null): boolean {
  return db.transaction(() => {
    const v = db.prepare("SELECT document_id, status, effective_date FROM quality_document_versions WHERE id = ?")
      .get(versionId) as { document_id: number; status: string; effective_date: string | null } | undefined;
    if (!v || v.status !== "pending") return false;
    // Supersede the current approved version of this document.
    db.prepare(
      "UPDATE quality_document_versions SET status='obsolete', updated_at=datetime('now') WHERE document_id=? AND status='approved'"
    ).run(v.document_id);
    const eff = effectiveDate ?? v.effective_date ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    db.prepare(
      "UPDATE quality_document_versions SET status='approved', approved_by=?, approved_at=?, effective_date=?, reject_reason=NULL, updated_at=datetime('now') WHERE id=?"
    ).run(approverId, new Date().toISOString(), eff, versionId);
    db.prepare("UPDATE quality_documents SET updated_at=datetime('now') WHERE id=?").run(v.document_id);
    return true;
  })();
}

/** Reject a pending version → back to draft-editable ('rejected') with a reason. */
export function rejectVersion(db: Database.Database, versionId: number, reason: string): boolean {
  const r = db.prepare(
    "UPDATE quality_document_versions SET status='rejected', reject_reason=?, updated_at=datetime('now') WHERE id=? AND status='pending'"
  ).run(reason, versionId);
  return r.changes > 0;
}

/** Staff read acknowledgement of a version (idempotent). */
export function acknowledgeVersion(db: Database.Database, versionId: number, userId: number): boolean {
  const r = db.prepare(
    "INSERT OR IGNORE INTO quality_document_acks (version_id, user_id) VALUES (?, ?)"
  ).run(versionId, userId);
  return r.changes > 0;
}

// ── Reads ────────────────────────────────────────────────────────────

export type DocumentListRow = QualityDocument & {
  effective_version_id: number | null;
  effective_rev: number | null;
  effective_date: string | null;
  latest_rev: number | null;
  latest_status: QualityVersionStatus | null;   // status of the newest revision (draft/pending/…)
  owner_name: string | null;
  branch_name: string | null;
};

/** All documents with their current effective version + newest-revision status. */
export function listDocuments(db: Database.Database, filter?: { docType?: QualityDocType }): DocumentListRow[] {
  const where = filter?.docType ? "WHERE d.doc_type = ?" : "";
  const params = filter?.docType ? [filter.docType] : [];
  return db.prepare(`
    SELECT d.*,
      ev.id AS effective_version_id, ev.rev AS effective_rev, ev.effective_date AS effective_date,
      lv.rev AS latest_rev, lv.status AS latest_status,
      ow.display_name AS owner_name, b.name AS branch_name
    FROM quality_documents d
    LEFT JOIN quality_document_versions ev ON ev.document_id = d.id AND ev.status = 'approved'
    LEFT JOIN quality_document_versions lv ON lv.id = (
      SELECT id FROM quality_document_versions WHERE document_id = d.id ORDER BY rev DESC LIMIT 1)
    LEFT JOIN users ow ON ow.id = d.owner_user_id
    LEFT JOIN branches b ON b.id = d.branch_id
    ${where}
    ORDER BY d.doc_type, d.doc_code
  `).all(...params) as DocumentListRow[];
}

/** A document with all its versions (newest first). */
export function getDocument(db: Database.Database, documentId: number): { doc: QualityDocument; versions: QualityVersion[] } | null {
  const doc = db.prepare("SELECT * FROM quality_documents WHERE id = ?").get(documentId) as QualityDocument | undefined;
  if (!doc) return null;
  const versions = db.prepare(
    "SELECT * FROM quality_document_versions WHERE document_id = ? ORDER BY rev DESC"
  ).all(documentId) as QualityVersion[];
  return { doc, versions };
}

/** The single effective (approved) version of a document, or null. */
export function effectiveVersion(db: Database.Database, documentId: number): QualityVersion | null {
  return (db.prepare(
    "SELECT * FROM quality_document_versions WHERE document_id = ? AND status = 'approved' ORDER BY rev DESC LIMIT 1"
  ).get(documentId) as QualityVersion | undefined) ?? null;
}

export type StaffDocRow = {
  document_id: number; doc_type: QualityDocType; doc_code: string; title: string;
  department: string | null; branch_id: number | null; branch_name: string | null;
  version_id: number; rev: number; effective_date: string | null;
  content: string | null; file_path: string | null; file_name: string | null; file_mime: string | null;
  acknowledged_at: string | null;
};

/**
 * Effective (approved) documents a staff member must read, scoped to the
 * branches they belong to (a doc with branch_id NULL applies to everyone).
 * Each row carries the staff member's own acknowledgement timestamp (or null).
 */
export function listEffectiveForStaff(db: Database.Database, userId: number): StaffDocRow[] {
  return db.prepare(`
    SELECT
      d.id AS document_id, d.doc_type, d.doc_code, d.title, d.department,
      d.branch_id, b.name AS branch_name,
      v.id AS version_id, v.rev, v.effective_date,
      v.content, v.file_path, v.file_name, v.file_mime,
      ack.acknowledged_at AS acknowledged_at
    FROM quality_documents d
    JOIN quality_document_versions v ON v.document_id = d.id AND v.status = 'approved'
    LEFT JOIN branches b ON b.id = d.branch_id
    LEFT JOIN quality_document_acks ack ON ack.version_id = v.id AND ack.user_id = @uid
    WHERE d.branch_id IS NULL
       OR d.branch_id IN (SELECT branch_id FROM user_branches WHERE user_id = @uid)
    ORDER BY (ack.acknowledged_at IS NOT NULL), d.doc_type, d.doc_code
  `).all({ uid: userId }) as StaffDocRow[];
}

export type AckStatus = {
  total: number; acked: number;
  ackedUsers: Array<{ user_id: number; display_name: string; acknowledged_at: string }>;
  pendingUsers: Array<{ user_id: number; display_name: string }>;
};

/**
 * Who has / hasn't acknowledged a version. Eligible = active staff/admin, scoped
 * to the document's branch when it has one (else all branches).
 */
export function ackStatus(db: Database.Database, versionId: number): AckStatus {
  const branchId = (db.prepare(`
    SELECT d.branch_id AS b FROM quality_document_versions v
    JOIN quality_documents d ON d.id = v.document_id WHERE v.id = ?
  `).get(versionId) as { b: number | null } | undefined)?.b ?? null;
  const branchClause = branchId != null
    ? "AND u.id IN (SELECT user_id FROM user_branches WHERE branch_id = @bid)" : "";
  const eligible = db.prepare(`
    SELECT u.id AS user_id, u.display_name
    FROM users u
    WHERE u.role IN ('staff','admin') AND u.employment_type IS NOT NULL
      AND u.is_test_account = 0 AND u.status NOT IN ('disabled','resigned','terminated')
      ${branchClause}
    ORDER BY u.display_name
  `).all(branchId != null ? { bid: branchId } : {}) as Array<{ user_id: number; display_name: string }>;
  const acks = db.prepare(
    "SELECT user_id, acknowledged_at FROM quality_document_acks WHERE version_id = ?"
  ).all(versionId) as Array<{ user_id: number; acknowledged_at: string }>;
  const ackMap = new Map(acks.map((a) => [a.user_id, a.acknowledged_at]));
  const ackedUsers: AckStatus["ackedUsers"] = [];
  const pendingUsers: AckStatus["pendingUsers"] = [];
  for (const u of eligible) {
    const at = ackMap.get(u.user_id);
    if (at) ackedUsers.push({ user_id: u.user_id, display_name: u.display_name, acknowledged_at: at });
    else pendingUsers.push({ user_id: u.user_id, display_name: u.display_name });
  }
  return { total: eligible.length, acked: ackedUsers.length, ackedUsers, pendingUsers };
}
