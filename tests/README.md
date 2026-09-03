# Testing

Two scripts, both black-box (real HTTP, real MySQL, real disk writes —
nothing mocked), both safe to run against a shared/staging database since
everything they create is tagged and cleaned up afterward.

## Prerequisites

1. MySQL reachable with the same `DB_*` env vars the app itself uses.
2. The server running in another terminal: `npm start`
3. Node 18+ (both scripts use the built-in `fetch`/`FormData`/`File` — no
   extra dependencies to install).
4. The admin login the scripts use defaults to `admin@kutkitech.com` /
   `Admin@123` (from `seed.js`). If your database has different admin
   credentials, set `TEST_ADMIN_EMAIL` / `TEST_ADMIN_PASSWORD`.

## `npm run test:routes`

Functional coverage of the main route groups: public/auth boundaries,
employee CRUD, staff login + check-in/check-out + leave requests, the
avatar/logo upload-to-disk flow (including the exact scenarios that used
to crash the app — oversized files, non-images, and two people uploading
at once), and the device-user link-and-backfill flow. Prints a pass/fail
summary; exits non-zero if anything failed.

```
node tests/route-tests.js
BASE_URL=http://localhost:4000 node tests/route-tests.js
```

## `npm run test:concurrency`

Two phases:

1. **Bulk load** — seeds a production-size roster (200 employees by
   default) plus 3 months of attendance history directly into MySQL in a
   couple of bulk operations, timed, so you can see real ingestion
   throughput on your hardware/hosting before trusting it with a real
   import.
2. **Concurrency correctness** — logs in as every seeded employee and
   fires their check-in, and a batch of avatar uploads, all at once
   through the live HTTP API, then verifies nothing was lost or
   cross-assigned (exactly one attendance row per employee, no shared
   avatar files) and that the server is still responsive afterward. Also
   runs an informational check on concurrent employee-record edits, which
   still use the app's original whole-table save pattern outside the
   avatar/logo paths — that one's reported as a finding, not a pass/fail
   gate, since fixing it is a larger, separate change.

```
node tests/concurrency-seed.js
SEED_EMPLOYEES=1000 CONCURRENCY=100 node tests/concurrency-seed.js
KEEP_DATA=1 node tests/concurrency-seed.js   # skip cleanup to inspect the seeded rows after
```

Everything both scripts create is prefixed `zt_<timestamp>_` /
`zc_<timestamp>_` and removed at the end (unless `KEEP_DATA=1`) — neither
one touches the real roster from `seed.js`.
