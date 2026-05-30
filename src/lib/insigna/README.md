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

## What's implemented (Phase 1-4)

- ✅ Schema migration + PII lint
- ✅ Hash service (LINE / phone / anonymous + rate-limiting)
- ✅ Customer upsert + profile + cascade delete
- ✅ Reservation sync + status updates
- ✅ Visit lifecycle: start / orders / menu interactions / end
- ✅ Ingestion audit on every state-changing call

## What's stubbed (later phases)

- ⏳ Phase 5 — Feedback service + AI sentiment stub
- ⏳ Phase 6 — Read endpoints (recommendations)
- ⏳ Phase 7 — Persona tagging job (rule-based)
- ⏳ Phase 8 — Churn detection job
- ⏳ Phase 9-10 — Marketing campaigns + multi-model attribution
- ⏳ Phase 11 — Analytics endpoints
- ⏳ Phase 12 — Referral codes
- ⏳ Phase 13 — Daily rollup
- ⏳ Phase 14 — Docs + tests

The PII wall already protects against the highest-impact regression
risk; the remaining phases extend INSIGNA's value but don't change
the wall.
