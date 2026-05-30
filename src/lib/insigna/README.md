# INSIGNA — Privacy-first marketing intelligence

**Mode A (in-process)** integration into IKIGAI ONE RESERVA.

## What lives here

```
src/lib/insigna/
├── hash.ts        HMAC-SHA256 wrapper around INSIGNA_SALT — the wall
├── audit.ts       Append-only ingestion log (payload_hash, not payload)
├── customers.ts   upsert / profile / delete cascade
├── reservations.ts shadow records of bookings (no PII)
├── visits.ts      visit lifecycle: start → orders → menu interactions → end
└── index.ts       single public surface — grep here to audit all wall-crossings
```

DB tables all carry the `insigna_` prefix. A **PII lint** (`db.ts`,
search for `FORBIDDEN_PII_COLS`) refuses to boot if any `insigna_*`
column matches a forbidden identity vector (`phone`, `email`, `name`,
`line_user_id`, `dob`, etc.). Adding an `email` column to an
`insigna_*` table is a build-time error, by design.

## Hash boundary

Booking code holds the LINE userId or phone. INSIGNA holds the hash.
The transition happens at the call site, not inside INSIGNA:

```ts
// ✅ correct — booking-side computes the hash inline, then forwards it
import { hashLineUserId, upsertCustomer } from "@/lib/insigna";
upsertCustomer({
  customer_hash: hashLineUserId(user.line_user_id),
  birth_year: user.dob ? Number(user.dob.slice(0, 4)) : null,
  consent_marketing: true,
  consent_analytics: true
});

// ❌ wrong — would push raw PII into INSIGNA storage
// (and the TypeScript signature already prevents it)
```

## Env var

| Var | Required | Purpose |
|---|---|---|
| `INSIGNA_SALT` | ✅ yes | HMAC salt. Must be ≥32 chars. **Different per environment.** |

### Rotation

When `INSIGNA_SALT` rotates:

1. Stop writes (maintenance banner → ON).
2. Recompute every `customer_hash` from a fresh booking-side join:
   `customer_hash = HMAC(new_salt, line_user_id)` for each user.
3. UPDATE rows in `insigna_customers` and every FK referencing
   `customer_hash` (reservations, visits, tags, touchpoints,
   referrals). One transaction.
4. Flip the env var, restart Next.js, lift the banner.

There is no operational reason to rotate unless the salt leaks.
The "every env has a different salt" rule already isolates dev /
staging / prod blast radius.

## What's implemented (Phase 1-13)

- ✅ Schema migration + PII lint
- ✅ Hash service (LINE / phone / anonymous + rate-limiting)
- ✅ Customer upsert + profile + cascade delete
- ✅ Reservation sync + status updates
- ✅ Visit lifecycle: start / orders / menu interactions / end
- ✅ Ingestion audit on every state-changing call
- ✅ **Phase 5** — Feedback service (+ AI sentiment stub for Phase 2)
- ✅ **Phase 7** — Persona tagging (rule-based, runs inline at endVisit)
- ✅ **Phase 8** — Churn risk scoring (median-gap based)
- ✅ **Phase 9** — Marketing campaigns + touchpoints
- ✅ **Phase 10** — Multi-model attribution (5 models, all computed per visit)
- ✅ **Phase 11** — Analytics endpoints (persona-distribution, cohort-retention, channel-performance, marketing-headline)
- ✅ **Phase 12** — Referral codes (mint + redeem + leaderboard)
- ✅ **Phase 13** — Daily marketing rollup (cron-wired to /api/cron after midnight ICT)

## What's stubbed (Phase 2 swap)

The three AI surfaces in `feedback.ts` return placeholders today. Each
function's doc-block contains the exact Claude prompt template to use
when Phase 2 lands:

- `analyzeFeedbackSentiment(comment)` — sentiment + theme extraction
- `synthesizePersonaDescription(hash)` — rich persona prose
- `generateDailyBriefing(date)` — pre-shift briefing for staff

Swap is a pure implementation change — same function signature, same
call sites.

## Pipeline diagram

```
Booking write
  │
  ▼
[booking-bridge.ts]      ← hash boundary
  │   - hashLineUserId / hashPhone / generateAnonymousHash
  │
  ├──► upsertCustomer
  ├──► syncReservation
  └──► startVisit (if status=seated)

      ↓ ... admin records orders / menu interactions ...

[endVisit fires]
  │
  ├──► recomputePersonaTag   (inline, single customer)
  ├──► recomputeChurnScore   (inline, single customer)
  └──► computeAttribution    (inline, 5 models, all touchpoints)

      ↓ ... nightly ...

[/api/cron]  (00:00-05:00 ICT)
  │
  ├──► rollupYesterday()     (per-channel daily aggregate)
  └──► recomputeAllChurn()   (bulk refresh of last_visit_at deltas)
```

## Read surface for the admin dashboard

All under `import { ... } from "@/lib/insigna"`:

| Function | Use |
|---|---|
| `getCustomerProfile(hash)` | Staff pre-visit briefing |
| `personaDistribution({from, to})` | Marketing overview pie |
| `cohortRetention({cohort_month})` | Retention curve (1-6 months out) |
| `channelPerformance({from, to, model})` | Channel comparison table |
| `marketingHeadline({from, to})` | Spend / revenue / ROAS / CAC headline |
| `churnRiskList({threshold, limit})` | Outreach list |
| `getReferralStats(owner_hash)` | Referral leaderboard |
| `getCampaignPerformance({campaign_id, model})` | Campaign deep-dive |
