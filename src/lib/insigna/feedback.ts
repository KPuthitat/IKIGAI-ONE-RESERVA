// INSIGNA — Feedback service (spec section 4.5 + 5.5).
//
// A visit can have at most ONE feedback row (visit_token UNIQUE in
// the schema). Customers submit a star rating + optional axis
// ratings (food / service / ambience) + optional free-text comment.
//
// AI sentiment analysis (sentiment + themes) is stubbed here for
// Phase 1 — the column lives in the schema and submitFeedback
// queues the call, but the actual Claude API integration ships in
// Phase 2. Calling code today gets back sentiment: null.

import { getDb } from "../db";
import { logInsignaEvent } from "./audit";

export type SubmitFeedbackArgs = {
  visit_token: string;
  rating: number;                  // 1-5 required
  food_rating?: number | null;
  service_rating?: number | null;
  ambience_rating?: number | null;
  comment?: string | null;
};

export type InsignaFeedback = {
  feedback_id: number;
  visit_token: string;
  rating: number;
  food_rating: number | null;
  service_rating: number | null;
  ambience_rating: number | null;
  comment: string | null;
  sentiment: string | null;
  themes: string | null;           // JSON-encoded array when populated
  submitted_at: string;
};

/** Insert (or replace) the feedback row for this visit. Validates
 *  the 1-5 ratings range here in addition to the CHECK constraints
 *  so the error path returns "invalid_rating" cleanly instead of a
 *  SQLite constraint-violation tag. */
export function submitFeedback(args: SubmitFeedbackArgs): InsignaFeedback {
  const ratings = [args.rating, args.food_rating, args.service_rating, args.ambience_rating];
  for (const r of ratings) {
    if (r != null && (r < 1 || r > 5 || !Number.isInteger(r))) {
      throw new Error("[INSIGNA] submitFeedback: ratings must be integers 1-5");
    }
  }

  const db = getDb();
  // visit existence + customer_hash lookup — feedback for a non-
  // existent visit is a client bug, not silent insert.
  const visit = db.prepare(
    "SELECT customer_hash FROM insigna_visits WHERE visit_token = ?"
  ).get(args.visit_token) as { customer_hash: string } | undefined;
  if (!visit) {
    throw new Error("[INSIGNA] submitFeedback: unknown visit_token");
  }

  // INSERT OR REPLACE — if the customer re-submits feedback for the
  // same visit (rare, but admin tools should support it for
  // correcting accidental 1-star taps), the new submission wins.
  db.prepare(`
    INSERT OR REPLACE INTO insigna_feedback
      (visit_token, rating, food_rating, service_rating, ambience_rating,
       comment, sentiment, themes, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, CURRENT_TIMESTAMP)
  `).run(
    args.visit_token,
    args.rating,
    args.food_rating ?? null,
    args.service_rating ?? null,
    args.ambience_rating ?? null,
    args.comment?.trim() || null
  );

  // Phase 2 hook — when comment is present we'd queue a Claude
  // sentiment + theme extraction. Today: log intent, leave columns
  // null. The analyzeFeedbackSentiment stub below is the swap target.
  if (args.comment && args.comment.trim()) {
    void analyzeFeedbackSentiment(args.comment).then((result) => {
      if (result) {
        getDb().prepare(`
          UPDATE insigna_feedback
          SET sentiment = ?, themes = ?
          WHERE visit_token = ?
        `).run(result.sentiment, JSON.stringify(result.themes), args.visit_token);
      }
    }).catch((e) => console.warn("[insigna-feedback] sentiment stub error", e));
  }

  logInsignaEvent({
    event_type: "feedback.submit",
    customer_hash: visit.customer_hash,
    payload: { visit_token: args.visit_token, rating: args.rating, has_comment: !!args.comment }
  });

  return db.prepare(
    "SELECT * FROM insigna_feedback WHERE visit_token = ?"
  ).get(args.visit_token) as InsignaFeedback;
}

// ── AI stubs (spec section 5.5) ──────────────────────────────────
// Phase 1: return placeholders. Phase 2 swaps in real Claude calls
// behind these same function names.

/** Analyse the sentiment + extract themes from a free-text comment.
 *  Phase 1 stub: returns null so the caller falls through to "no
 *  sentiment". Phase 2 will call Claude with:
 *
 *    SYSTEM: You are a restaurant feedback analyst. Read the
 *    customer comment in Thai or English. Return JSON
 *    { sentiment: "positive"|"neutral"|"negative",
 *      themes: ["food_quality", "service_speed", ...],
 *      suggested_response: string }.
 *    Be brief; themes are 1-4 short snake_case tokens.
 *    USER: <the comment>
 */
export async function analyzeFeedbackSentiment(_comment: string): Promise<
  { sentiment: "positive" | "neutral" | "negative"; themes: string[] } | null
> {
  // Intentionally unused in Phase 1.
  void _comment;
  return null;
}

/** Generate a rich persona description from the customer's tag set
 *  + visit history. Phase 1: returns a static line. Phase 2: Claude.
 *
 *  PROMPT TEMPLATE (Phase 2):
 *    SYSTEM: You are writing a one-paragraph internal note for
 *    restaurant staff about an incoming customer. No PII (you have
 *    none). Highlight what the staff should know to delight them.
 *    USER: persona_tag={tag}, total_visits={n}, top_categories=[...],
 *          avg_party_size={x}, recurring_dishes=[...]
 *
 *  Output: 2-3 sentences in Thai. */
export async function synthesizePersonaDescription(
  customer_hash: string
): Promise<string> {
  // Intentionally cheap until Phase 2 wires Claude.
  const db = getDb();
  const row = db.prepare(
    "SELECT persona_tag, total_visits FROM insigna_customers WHERE customer_hash = ?"
  ).get(customer_hash) as { persona_tag: string | null; total_visits: number } | undefined;
  if (!row) return "ลูกค้าใหม่ — ยังไม่มีประวัติในระบบ";
  return `Persona: ${row.persona_tag ?? "ยังไม่ระบุ"} · มาทั้งหมด ${row.total_visits} ครั้ง`;
}

/** Compose the day's pre-shift briefing for staff. Phase 2: Claude
 *  reads the reservation list + each customer's profile + recent
 *  feedback and returns a 5-bullet briefing in Thai. */
export async function generateDailyBriefing(_date: string): Promise<{
  bullets: string[];
}> {
  void _date;
  return {
    bullets: [
      "Phase 2 stub — ระบบยังไม่ได้เชื่อม Claude API"
    ]
  };
}
