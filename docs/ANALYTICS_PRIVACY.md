# Analytics privacy boundary

Mimir sends product events only through `lib/analytics/server.ts`. Browser code posts
to `/api/analytics/event`; workers call the same server capture function. No caller may
send directly to PostHog.

## Data contract

Each event name has an allowlist in `EVENT_PROPERTY_SCHEMA`. Add a property there and
add positive, negative, and regression coverage in `tests/node/analytics.test.ts`.
Unknown, mistyped, non-finite, secret-shaped, overlong, or structurally excessive
values are dropped before serialization. Raw Stellar identities and secret seeds are
never analytics properties. The sole address exception is the public top-level
`contract` C-strkey.

Human wallet addresses become a stable HMAC-SHA-256 actor id only when the server-only
`ANALYTICS_ACTOR_SALT` has at least 16 characters. Missing or weak salts, malformed
addresses, and unsafe agent
ids degrade to `anon`; a raw identity is never the fallback. Salt rotation deliberately
breaks linkage to historical actor ids.

Idempotency keys are HMACed before becoming PostHog `$insert_id` values; without a
strong salt they are omitted. Dropped-field diagnostics contain property paths only,
never values. PostHog remains a
product-observability system, not a financial ledger: contract state and the payment
ledger remain the source of truth for stakes, payouts, fees, and revenue.

## Reproduce and release

A clean checkout needs Node 22 and `npm ci`; it needs no PostHog key, actor salt,
wallet seed, database, or live network access.

```sh
npm ci
node --import tsx --test tests/node/analytics.test.ts tests/node/analytics-quality.test.ts
npm run typecheck
npm run test:smoke
npm run verify:analytics -- path/to/export.json
```

The focused tests cover accepted categorical fields, secret/address removal, invalid
schema values, malformed structures, actor hashing/degradation, and regressions. The
full node suite is the release check. `verify:analytics` is an optional exported-data
quality gate; its input JSON is an operator-provided artifact and must not contain raw
wallets or secrets. Do not commit exports. The checker needs no production credential.

For a release, configure `POSTHOG_API_KEY`, `POSTHOG_HOST`, a random server-only
`ANALYTICS_ACTOR_SALT`, and an explicit `ANALYTICS_ENVIRONMENT`. Preview and CI
must use `test`. Production is tagged `production`. Keep the salt in the deployment
secret store; never prefix it with `NEXT_PUBLIC_`.

## Failure and rollback

Capture is best-effort and awaited. Invalid fields are removed; incomplete envelopes,
unknown events, consent denial, disabled analytics, and transport failures do not
throw into a funded action. They also cannot approve, submit, settle, or account for
money. Operators can inspect the privacy-safe `CaptureResult.reason` and dropped
paths at trusted server call sites.

Set `ANALYTICS_DISABLED=1` for immediate rollback. This disables capture without
stopping create, stake, settlement, withdrawal, deployment, or artifact verification.
A code rollback needs no database or contract migration because the event schema has
no chain or storage effect. Re-enable only after the focused tests and full release
checks pass. Rotating the actor salt is an identity reset, not a normal rollback.