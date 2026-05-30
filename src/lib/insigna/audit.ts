// INSIGNA — Ingestion audit (spec section 3.13 + 6.4).
//
// Every state-changing call into INSIGNA writes one row here so
// "what events did INSIGNA process and when" stays answerable
// without ever recording what those events contained.
//
// The payload_hash column stores a SHA-256 of the JSON-stringified
// payload — enough to verify "this exact event happened" against
// a re-hash of an external log, but useless for reconstructing
// the payload itself. The customer_hash column is pseudonymous
// (it's the same opaque hash used everywhere else in INSIGNA),
// so a leaked audit row reveals neither WHO the customer was nor
// WHAT they ordered.

import { getDb } from "../db";
import { hashPayload } from "./hash";

type AuditEntry = {
  event_type: string;
  customer_hash?: string | null;
  payload: unknown;
  processed?: boolean;
  error?: string | null;
};

/** Append an audit row. Wrap any state-changing INSIGNA call in
 *  this — the spec is explicit that every ingestion is logged.
 *  The hash of the payload is what we store, not the payload. */
export function logInsignaEvent(entry: AuditEntry): void {
  try {
    getDb().prepare(`
      INSERT INTO insigna_ingestion_audit
        (event_type, customer_hash, payload_hash, processed, error)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      entry.event_type,
      entry.customer_hash ?? null,
      hashPayload(entry.payload),
      entry.processed === false ? 0 : 1,
      entry.error ?? null
    );
  } catch (e) {
    // The audit log MUST NOT take down the caller. A failed audit
    // is a problem, but the underlying business event has already
    // happened — eating the error and warning is safer than
    // pretending the event itself failed.
    console.warn("[insigna-audit] write failed:", e);
  }
}
