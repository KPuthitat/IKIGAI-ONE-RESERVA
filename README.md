# IKIGAI ONE RESERVA

Multi-module business platform serving NAMA PASTA SRIRACHA + HYPOPLARAEMIA
(restaurants) and AT-HOME CLINIC + OMNIA HEALTH LAB (clinic / lab).

**Modules**

- **RESERVA** — table booking (customer-facing) + admin floor plan +
  per-branch LINE notifications + Google Maps reservation link.
- **PERSONA** — HR / staff operations: clock-in (with GPS + QR
  anti-cheat), 4 daily report types (shift open/close + readiness
  11:30/16:00), monthly roster, leave + resignation requests,
  disciplinary warnings with auto-escalation, MBTI profiles, daily
  attendance summary to executive group.
- **INVENTA** (early) — inventory + low-stock alerts.

**Stack**

- Next.js 14 (App Router, server components first)
- SQLite via `better-sqlite3` (single-file DB on the VPS)
- Tailwind CSS + LINE Seed Sans TH font (self-hosted)
- LINE Messaging API (4 OAs — see [LINE OA channels](#line-oa-channels))
- TypeScript strict; pre-build validation chain (see [Build chain](#build-chain))

---

## Production

| Resource | Value |
|---|---|
| Host | DigitalOcean droplet (Ubuntu 24.04 LTS) — `s-1vcpu-1gb-sgp1` |
| URL | https://ikigaimedihealth.com/reserva |
| Process manager | PM2 (`reserva` process, fork mode, port 3010) |
| Reverse proxy | Nginx (sibling service `ikigai-payroll` also lives here) |
| Database | `/var/www/reserva/data/reserva.db` (SQLite, ~50 MB current) |
| Source | https://github.com/KPuthitat/IKIGAI-ONE-RESERVA |
| Branch deployed | `main` (auto-pulled by hand — no CI/CD yet) |

### Deploy a new release

One-liner from VPS shell:

```bash
cd /var/www/reserva && git pull origin main && npm run build && pm2 restart reserva && pm2 status
```

`npm run build` runs the prebuild chain first (see [Build chain](#build-chain)). If
prebuild fails the build aborts, PM2 keeps the old build running — so a bad
push doesn't take production down. After a successful build, `pm2 restart`
swaps to the new build with ~2-3 seconds of downtime.

### Rollback procedure

If a deploy breaks production:

```bash
cd /var/www/reserva
git log --oneline -10                # find the last-known-good SHA
git checkout <good-sha>
npm run build
pm2 restart reserva
```

Then on your laptop, push a `git revert <bad-sha>` so main matches what's
running. **Schema migrations are forward-only** — if the bad commit included
`ALTER TABLE`, the rolled-back code may still read columns the DB has but
that's harmless. Don't try to "downgrade" a migration; instead, write a new
forward migration that fixes the issue.

### Recovery from disk loss

Recovery point is whatever the last successful backup captured. Backup is
**not yet automated** — manual recovery means rebuilding from `git pull` +
losing the DB. See [Roadmap](#roadmap) — backup automation is the next
infra priority.

---

## LINE OA channels

The system uses **4 separate LINE Official Accounts**, each with its own
quota. Routing logic lives in [`src/lib/line.ts`](src/lib/line.ts).

| Channel code | OA name | Plan | Used for |
|---|---|---|---|
| `nama-sriracha` | NAMA PASTA SRIRACHA | Paid 35k/mo | Customer booking confirms, broadcast marketing, NAMA staff group |
| `hypoplaraemia` | HYPOPLARAEMIA | Free 300/mo | (Same as NAMA, smaller volume) |
| `at-home-clinic` | AT HOME CLINIC | Paid 35k/mo | Clinic marketing broadcasts |
| `ikigai-os` | IKIGAI OS PORTAL (Platform) | Paid 15k/mo | Clock-in personal cards, shift reports, discipline, roster publish, daily attendance summary — **all internal staff traffic** |

### Routing fall-back

`notifyToStaffGroup(branch, flex, "global")` (used by shift reports,
discipline, roster, attendance summary):

1. If `messaging_channels.ikigai-os.channel_token` is set AND
   `system_settings.global_staff_group_id` is set → push via IKIGAI OS
   to the cross-branch executive group.
2. Otherwise → fall back to `notifyDailyReport(branch, flex)` which uses
   the branch OA's token + `branch.staff_group_id`.

`notifyStaff` (booking-related) and inventa orders **always** use the
branch OA + branch staff group — no global option.

### Quota dashboard

Real-time per-channel quota + usage at
[`/admin/persona/messaging/quota`](https://ikigaimedihealth.com/admin/persona/messaging/quota).
Pulls straight from LINE's `/v2/bot/message/quota` and
`/v2/bot/message/quota/consumption` endpoints — more accurate than the
LINE OA Manager UI which lags reality by hours.

---

## Build chain

Every `npm run build` runs the prebuild script first
(`scripts/check-i18n.ts` + `scripts/scan-build-risks.mjs` + `tsc --noEmit`).
Each check exists because a real production-breaker slipped past us:

| Check | Catches |
|---|---|
| `check-i18n.ts` | Duplicate keys inside the same `th:` or `en:` dict — used to silently lose a label until found in QA. |
| `scan-build-risks.mjs` | `"use client"` files importing modules that pull `better-sqlite3` (server-only) — caused Next.js bundle errors that were hard to diagnose. |
| `tsc --noEmit` | Type errors — Next.js build itself runs TS check too, but tsc is faster + clearer error output. |

`prebuild` is in `package.json` so `npm run build` triggers it automatically.
If any check fails the build aborts before `next build` even starts.

---

## Local development (rare — most work is direct against VPS)

### Prerequisites

- Node.js LTS ≥ 20
- Windows: `winget install OpenJS.NodeJS.LTS`
- macOS: `brew install node`

### First-time setup

```bash
npm install
cp .env.example .env
# Edit .env — set SESSION_SECRET + CRON_SECRET to random long strings
npm run db:init
```

Seeds the DB with 2 branches + 8 tables each + admin user
(`admin` / `admin1234` — change immediately).

### Run dev server

```bash
npm run dev
# Opens on http://localhost:3000
```

### Useful scripts

```bash
npm run dev          # dev with hot reload
npm run build        # production build (prebuild gate + next build)
npm start            # run the built bundle
npm run db:init      # init schema + seed admin
npm run cron:run     # manually fire cron (reminders + cleanup)
npm run check:i18n   # i18n duplicate-key scanner only
npm run check:risks  # client/server bundle scanner only
npm run check:types  # tsc only
```

---

## Important env vars

| Var | Purpose | Required? |
|---|---|---|
| `SESSION_SECRET` | Cookie signing for admin sessions | Yes |
| `CRON_SECRET` | Bearer token for `POST /api/cron` | Yes |
| `PUBLIC_BASE_URL` | Used to build LINE Flex deep-link URLs | Recommended (defaults to ikigaimedihealth.com) |
| `RETENTION_DAYS` | How many days of bookings to keep | Optional, defaults 60 |

LINE channel tokens are stored in the DB (`messaging_channels` table),
not env — admins paste them via `/admin/persona/messaging` UI.

---

## Architecture overview

```
src/
├── app/                           Next.js App Router
│   ├── reserva/[branch]/         Customer booking flow (RESERVA)
│   ├── staff/persona/            Staff clock-in + reports + leave (PERSONA)
│   ├── admin/                    Admin console for both modules
│   ├── api/                      REST endpoints + LINE webhooks + cron
│   ├── persona/                  Customer-facing LIFF claim/portal pages
│   └── components/               Shared UI primitives (Sidebar, OwlMascot, ...)
├── lib/
│   ├── db.ts                     SQLite handle + migration runner + types
│   ├── schema.sql                Initial DB schema (migrations live in db.ts)
│   ├── auth.ts                   session/cookie/RBAC helpers
│   ├── line.ts                   LINE Messaging API + every Flex card
│   ├── line-quota.ts             Per-channel quota dashboard helper
│   ├── messaging-channels.ts     Multi-OA channel resolver
│   ├── table-allocator.ts        Best-fit table picker for booking
│   ├── roster.ts                 Roster grid + publish + assignment helpers
│   ├── discipline.ts             Warning issue + escalation suggestion
│   ├── i18n.ts                   th / en dictionaries (~2200 keys each)
│   └── time.ts                   Bangkok timezone helpers
├── scripts/
│   ├── init-db.ts                Seed first-run DB
│   ├── seed.ts                   Demo data
│   ├── cron.ts                   Standalone cron entry (legacy; prefer /api/cron)
│   ├── check-i18n.ts             Pre-build duplicate-key scanner
│   └── scan-build-risks.mjs      Pre-build client/server bundle scanner
└── data/                          SQLite file lives here (.gitignored)
```

**Multi-tenancy** is per-branch. Most admin queries filter by
`user.activeBranchId`; cross-branch features (executive notifications,
super-admin user management) are explicitly opt-in.

**LIFF integration** — each branch's customer booking page can load
the LINE LIFF SDK so customers in the LINE in-app browser get their
`line_user_id` captured automatically, enabling Flex confirmation
push. Outside LINE (Safari/Chrome direct), customers can still book
but won't receive LINE notifications until they add the OA later.

---

## Common operations

### Re-init a branch's LINE channel

If a token rotates:
1. `/admin/persona/messaging` → paste new Channel Access Token + Secret
2. Verify on `/admin/persona/messaging/quota` (token should produce a valid quota response within ~30s of save)
3. Test push via the diagnostic button on `/admin/persona/messaging`

### Reset an admin password

```bash
ssh root@<vps>
cd /var/www/reserva
node --import tsx -e "
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
const db = new Database('./data/reserva.db');
const hash = bcrypt.hashSync('NEW_PASSWORD_HERE', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, 'admin');
console.log('done');
"
```

### Inspect what shift report a staff member submitted

`/admin/persona/shift-reports` → click "🔍 ดูรายละเอียด" on the row.

### Check quota usage right now

`/admin/persona/messaging/quota` — auto-refreshes every 10 min, or
click "↻ รีเฟรชเดี๋ยวนี้".

---

## Roadmap

### Engineering hygiene (priority)

- [ ] **Automated database backup** — daily SQLite dump → off-VPS storage
      (Dropbox/S3/Google Drive); restore-test monthly
- [ ] **Staging droplet** — second VPS, deploy + smoke-test before
      promoting to production (avoid the "test on production" pattern)
- [ ] **Unit tests** for critical pure-logic libs (`line-quota`,
      `discipline`, `table-allocator`)
- [ ] **GitHub Actions CI** — run tsc + i18n + risks check on every
      push so broken code can't reach `main`

### Feature backlog

See in-conversation task list. Top items:

- PERSONA: pre-fill checklist items from previous day's values
- PERSONA: 7-day historical report view
- PERSONA: MBTI display + leader-matching helper
- MARKETA CRM module (customer profile aggregation, occasion-based
  offers, automated win-back when customer hasn't visited in 60 days)

---

## License

Private. Internal use at NAMA PASTA SRIRACHA / HYPOPLARAEMIA /
AT HOME CLINIC / OMNIA HEALTH LAB only.
