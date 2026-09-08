# UK AQ Media

Standalone implementation: three deployed Cloudflare Workers sharing authoritative
D1 state, with Queue-driven Air Quality News RSS discovery. It is not connected to
the public UK AQ website.

The behavioural authority is the sibling
[Media contract](../TEST-uk-aq-system-docs/system_docs/media/media_contract.md).
This README describes this implementation, not a replacement contract.

## Workspace

| Area | Contents |
| --- | --- |
| `apps/media-public` | Approved public feed only; `MEDIA_DB` binding |
| `apps/media-admin` | Bearer-authenticated editorial reads/transitions; `MEDIA_DB`, `MEDIA_ADMIN_TOKEN` |
| `apps/media-discovery` | Authenticated scheduler receiver, temporary native Cron producer and single Queue consumer; `MEDIA_DB`, `MEDIA_DISCOVERY_QUEUE`, `UK_AQ_MEDIA_WORKER_HTTP_SECRET`, dormant `AI` binding |
| `packages/core` | Shared source/article/policy types, D1 source loading, canonical URL identity, HTTP helpers |
| `packages/discovery` | Bounded AQN RSS adapter, source-run/article persistence, typed work messages |
| `packages/enrichment` | Provider-neutral structured result, policy gate, local budget and disabled Workers AI skeleton |
| `migrations` | Core tables/indexes/triggers and generated initial ten-source seed |
| `config/sources.seed.json` | Initial operational source permission posture |
| `scripts` | Seed validation/generation and local Wrangler tools |
| `docs/phase-1-handover.md` | Manual setup/deployment commands, validation evidence, real-operation checks and rollback |

Use Node 22.12+ and npm. From this repository root:

```sh
npm ci
npm run types
npm run check
npx wrangler d1 migrations apply MEDIA_DB --local --config apps/media-discovery/wrangler.jsonc
```

`npm run check` validates the seed against the shared schema, typechecks all apps
and packages, and bundles each Worker with `wrangler deploy --dry-run`. It does not
deploy. `npm run types` regenerates each Worker's binding interface from its config.
Wrangler-generated output, dependencies, local databases and local credentials are
ignored by Git. No functional test suite has been added.

Seed SQL is `0002_launch_sources.sql`, generated with `npm run seed:generate`.
It inserts missing source identities only; it never overwrites existing D1 policy
settings. After first deployment, change operational policy through a later admin
configuration route or a reviewed migration, rather than rerunning a seed expecting
updates. Only AQN is initially enabled; the other nine adapters are deferred.

## HTTP surface

Public:

- `GET /articles?limit=20` — default 20, maximum 50; newest first by publication
  time (discovery time when absent), then descending ID.
- `next_before` is an opaque cursor. URL-encode it as the `before` parameter for
  the next page. No offset pagination or generic query language.

The response includes original headline/link/publisher, available date/author,
structured tags, optional UK AQ editorial fields with their human/AI origin, and a
permitted remote preview URL. Descriptions/bodies and internal fields are absent.
Only approved articles are selected. Successful responses allow five minutes of
caching; errors use `no-store`. No cross-origin integration is configured yet.

Admin requests require `Authorization: Bearer <MEDIA_ADMIN_TOKEN>` and use
`Cache-Control: no-store`:

- `GET /admin/articles?status=pending&limit=20` — optional status, maximum 50;
  status-filtered reads use feed chronology, unfiltered reads use update chronology.
- `GET /admin/sources?limit=20` — maximum 50.
- `GET /admin/runs?limit=20` — most recent runs, maximum 50.
- `POST /admin/articles/:id/approve` — pending/rejected to approved.
- `POST /admin/articles/:id/reject` — pending/approved to rejected.
- `POST /admin/articles/:id/hide` — approved to hidden.
- `POST /admin/articles/:id/unhide` — hidden to approved.

Every POST requires a unique `Idempotency-Key` of 16–100 ASCII letters, digits,
hyphens or underscores (a UUID is suitable). Reuse the same key when retrying the
same action. A successful replay returns the original receipt with `replayed: true`,
even if another action subsequently changed the article. Reusing a key for another
article/action or requesting an invalid transition returns 409. A missing key is
400. Missing/wrong authentication is 401; unknown articles/routes are 404; storage
failure is 503. The bodies of POST requests are unused.

A state change and append-only event commit atomically through SQL triggers.
`MEDIA_SYNC_TOKEN` is reserved for later read-only `/sync` endpoints and is never
accepted by `/admin`; no sync endpoint or MySQL mirror is implemented in this phase.
Source policy editing, UK AQ text/tag editing and dashboard UI are also deferred.

The discovery Worker exposes one authenticated backend scheduling route:

- `POST /scheduler/run` requires `UK_AQ_MEDIA_WORKER_HTTP_SECRET` only through
  `x-uk-aq-worker-http-secret` and returns `202` with `{ "ok": true, "queued": 1 }`
  when one AQN scan is queued, or `queued: 0` when AQN is disabled or absent.
- Authentication failure returns `401` before any D1 or Queue access. Other methods
  on that path return `405` with `Allow: POST`; unknown paths return `404`.
- Request data cannot select a source, choose a message type or inject arbitrary
  Queue work. The body is ignored and the route only initiates the existing bounded
  Queue-based scheduled-discovery path.
- D1 or Queue failure records/logs `discovery_schedule_failed` and returns `503`
  without exposing exception or secret details.

`workers.dev` is enabled for `media-discovery` solely so the central scheduler in
another Cloudflare account can reach this authenticated endpoint. The central
scheduler job has not yet been configured or operationally proven. The existing
`*/30 * * * *` Media Cron remains configured until the central path is proven; the
normal standalone cadence remains two-hourly (`0 */2 * * *`) for a later change.

`UK_AQ_MEDIA_WORKER_HTTP_SECRET` remains a required Cloudflare Worker secret. Its
value is stored as an encrypted GitHub Actions repository secret, never in source
or Wrangler vars. The Media deployment workflow constructs an in-memory JSON
payload and uses the standard UK AQ `wrangler secret bulk` pattern to apply only
this secret to `uk-aq-media-discovery` immediately before deploying that Worker.
Changing the GitHub Actions secret and running a normal Media deployment therefore
restores or updates the discovery Worker secret. Other Worker secrets, especially
`MEDIA_ADMIN_TOKEN`, retain their existing management path.

## Discovery and policy boundaries

The native Cron and authenticated scheduling route share one helper that enqueues
AQN `source_scan` work only when its D1 source is enabled. The consumer reloads and
validates D1 policy; the adapter allowlist prevents unfinished publishers from
running even if enabled. Work messages carry identities, never bodies.

Each AQN scan fetches only `https://airqualitynews.com/feed/`, with no redirect
following, a 20-second timeout, a 1 MiB limit and at most 20 recent entries. It
rejects XML entity declarations, ignores feed descriptions and `content:encoded`,
and stores metadata only. Feed-supplied image metadata is accepted only as HTTPS
URLs on the AQN domain/subdomains; article pages and image bytes are never fetched.
Images supplied only inside article content are deliberately unavailable.

Canonical identity removes fragments and known tracking parameters, normalises
source/www aliases and AQN trailing slashes, preserves meaningful query parameters,
and hashes the canonical URL with SHA-256. Unique URL/hash constraints prevent
exact duplicates. Rediscovery updates only last-seen/updated timestamps. It cannot
restore rejected/hidden articles or overwrite manual content/image choices.

All new AQN articles are relevant without UK/topic filtering. The seeded
`auto_approve` policy creates them approved with `trusted_source_auto` provenance;
AI does not participate. AQN snapshots `standard` review level because the contract
keeps review levels to standard/enhanced; its exception is represented by publication
policy and approval method. If an operator changes AQN to manual, the shared policy
gate fails conservatively to pending until the contract/config discrepancy is resolved.

Successful scans atomically persist articles, exactly one creation/auto-approval
event per new identity, and run counters. Runs record bounded codes rather than
feed content/error dumps. Queue acknowledgement follows completion of those writes.
Failures retry after five minutes, at most three times; without a dead-letter queue,
exhausted messages are discarded and the next scheduled scan retries discovery.
A long outage can exceed the feed's recent window; historical recovery is deferred.

All ten source configurations disable AI and allow discovery metadata only. Nine
unimplemented sources also block images. No seed asserts a permanent legal
permission; Defra richer/OGL processing remains disabled pending its adapter work.
Source-level and article-level image blocks are both checked on public reads.

The enrichment package validates structured advisory results and provenance, gates
input by source policy before provider access, and defaults its local call guard
to zero. AQN is explicitly excluded. The Workers AI skeleton has no inference call,
model default, crawling path, or paid fallback. The per-run guard is not a durable
daily/account-wide budget: that is a prerequisite for enabling live AI later.

See the [phase handover](docs/phase-1-handover.md) for manual resource wiring,
real-operation validation, known limits and rollback.
