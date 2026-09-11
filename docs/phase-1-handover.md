# Phase 1 implementation handover — 7 September 2026

All implementation is in `TEST-uk-aq-media`, remote identity
`https://github.com/TEST-uk-aq/uk-aq-media.git`. Changes remain unstaged and uncommitted.
No remote resource creation, migration, deployment, website integration or other
repository mutation was performed.

## Display-title AI accounting addendum — 11 September 2026

The current local implementation adds advisory display-title suggestions and a
request-level neuron ledger. Migration `0007_media_ai_neuron_ledger.sql` is forward-only:
`0006` had already reached `main` and the normal deployment workflow can apply migrations
before Workers, so its possibly-applied call-counter history was not rewritten without a
remote D1 query. A non-zero legacy day is carried forward with its request/title counts
but unknown token usage and a full 8,000-neuron conservative charge for that UTC day.
No remote migration, deployment or Workers AI request was made here.

Discovery uses `MEDIA_AI_MAX_REQUESTS_PER_RUN=10`,
`MEDIA_AI_DAILY_NEURON_BUDGET=8000`,
`MEDIA_AI_ACCOUNT_FREE_NEURONS_PER_DAY=10000`,
`MEDIA_AI_MAX_TITLES_PER_REQUEST=5`, and the configured `MEDIA_AI_MODEL`. The current
path remains single-title. It atomically reserves a conservative integer-microneuron
amount before inference, then replaces it once with calculated usage when Cloudflare
returns valid prompt/completion/total token counts. Missing/malformed usage or a failed
reconciliation leaves the reservation charged. Unknown model rates disable automatic AI.

Authenticated `GET /admin/ai-usage` reports current/recent UTC-day request, title,
token, actual-neuron, outstanding-reservation and remaining-budget values. Its
Cloudflare-free remaining value is explicitly an estimate limited to Media D1 records;
the Cloudflare dashboard remains authoritative for account-wide usage.

## Delivered files and storage

Created files (all new; no pre-existing runtime files required archiving):

```text
.gitignore
AGENTS.md
README.md
apps/media-admin/.dev.vars.example
apps/media-admin/package.json
apps/media-admin/src/index.ts
apps/media-admin/worker-configuration.d.ts
apps/media-admin/wrangler.jsonc
apps/media-discovery/package.json
apps/media-discovery/src/index.ts
apps/media-discovery/worker-configuration.d.ts
apps/media-discovery/wrangler.jsonc
apps/media-public/package.json
apps/media-public/src/index.ts
apps/media-public/worker-configuration.d.ts
apps/media-public/wrangler.jsonc
config/sources.seed.json
docs/phase-1-handover.md
migrations/0001_media_core.sql
migrations/0002_launch_sources.sql
package-lock.json
package.json
packages/core/package.json
packages/core/src/canonical-url.ts
packages/core/src/db.ts
packages/core/src/http.ts
packages/core/src/index.ts
packages/core/src/policy.ts
packages/discovery/package.json
packages/discovery/src/aqn.ts
packages/discovery/src/index.ts
packages/enrichment/package.json
packages/enrichment/src/index.ts
scripts/source-seed.ts
scripts/worker-tools.mjs
tsconfig.json
```

 Root setup includes `AGENTS.md`, `README.md`, `.gitignore`, npm manifests and
lockfile, and `tsconfig.json`. Each of the three `apps/media-*` directories contains
a package manifest, Worker entrypoint, Wrangler config and generated binding types.
Shared packages contain policy/schema/HTTP/URL helpers, the AQN adapter and run
persistence, and the enrichment interfaces. `config`, `scripts`, `migrations` and
this handover complete the scaffold.

The first migration creates:

- `media_sources`: stable source key, configuration/permissions, review level and timestamps.
- `media_articles`: identity, metadata, editorial state/provenance, image policy,
  tags, optional UK AQ content, future AI provenance, editorial timestamps/revision.
- `media_discovery_runs`: per-attempt bounded diagnostics and discovery counters.
- `media_article_events`: append-only creation/editorial provenance, unique event keys.

Unique canonical URL and SHA-256 indexes protect identity. Additional indexes cover
approved feed chronology, per-source chronology, article/source/run update reads,
recent runs, and article/event chronology. Triggers make initial auto-approval and
manual transition events atomic with their article writes. Event update/delete is
blocked. The second migration seeds ten sources from typed/validated JSON without
replacing operational settings on replay. Only AQN is enabled and auto-approved;
BBC/Guardian/Sky/Independent/Defra are manual/standard, and Times/Telegraph/Daily
Mail/Sun are manual/enhanced.

## Local validation evidence

- npm dependency resolution succeeded; installation reported zero known vulnerabilities.
- Wrangler 4.129.1 generated bindings for all three configurations.
- TypeScript typecheck passed across all packages and apps.
- Seed schema validation and generated SQL/config equality passed for all ten sources.
- All three `wrangler deploy --dry-run` bundles succeeded using placeholder D1 IDs.
- In-memory SQLite applied both migrations, passed integrity/foreign-key checks,
  seeded ten rows, and used the intended indexes for public/cursor/source/sync reads.
- Local Wrangler D1 applied both migrations successfully (core schema and ten-source seed).
- One bounded AQN RSS shape check returned HTTP 200, 55,587 bytes, nine entries,
  title/link/creator/pubDate/category fields and tracking parameters. Descriptions
  and full-content feed fields were observed but not retained. No article pages or
  images were fetched, and no AI was called.

These checks establish structural viability, not deployed functional correctness.
The implementation uses D1's documented transactional batch behaviour and Queues'
explicit per-message acknowledgement/retry methods:
[Cloudflare D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[Queues acknowledgements](https://developers.cloudflare.com/queues/configuration/batching-retries/).
Configuration was checked against the installed Wrangler schema and
[Cloudflare configuration docs](https://developers.cloudflare.com/workers/wrangler/configuration/).

## Manual resources and deployment — not executed

Use the existing **UK AQ Media** account on Workers Free. This is one standalone
service, not permanent TEST/LIVE copies. Recheck Free allowances/account plan before
first deployment. Do not enable paid inference or an automatic paid fallback.

| Resource | Binding/configuration |
| --- | --- |
| D1 database `uk-aq-media` | `MEDIA_DB` in all three Workers; same real database UUID |
| Queue `uk-aq-media-discovery` | Logical UK AQ Media discovery queue; producer binding `MEDIA_DISCOVERY_QUEUE`, consumer on discovery Worker |
| Worker `uk-aq-media-public` | Public GET API, D1 only; workers.dev endpoint initially |
| Worker `uk-aq-media-admin` | Authenticated editorial API; `MEDIA_ADMIN_TOKEN` secret |
| Worker `uk-aq-media-discovery` | Cron `0 */2 * * *`, Queue producer/consumer, no public workers.dev endpoint |
| Workers AI | `AI` binding on discovery; neuron-budgeted display-title suggestions only, with no paid fallback |
| Future sync credential | Reserve a distinct `MEDIA_SYNC_TOKEN`; not needed/configured until sync endpoints exist |

No account ID, real database ID or credential is committed. The all-zero database
UUID is a placeholder; replace it in all three configs after database creation.
Keep the same database name/binding and `migrations_dir: ../../migrations`.
Wrangler authentication must select the UK AQ Media account; keep its ID only in
local process environment if needed.

Run these commands manually from the Media repository root, only when deployment
is authorised:

```sh
npx wrangler login
# Set this locally to the UK AQ Media account ID; never commit it.
export CLOUDFLARE_ACCOUNT_ID='<UK_AQ_MEDIA_ACCOUNT_ID>'
npx wrangler d1 create uk-aq-media
npx wrangler queues create uk-aq-media-discovery
```

Expected: a database UUID and queue creation confirmation. Replace the all-zero D1
UUID in all three `wrangler.jsonc` files with that returned UUID before continuing.

```sh
npm run types
npm run check
npx wrangler d1 migrations apply MEDIA_DB --remote --config apps/media-discovery/wrangler.jsonc
npx wrangler d1 execute MEDIA_DB --remote --config apps/media-discovery/wrangler.jsonc --command 'SELECT source_key, enabled, publication_policy, review_level FROM media_sources ORDER BY source_key'
npx wrangler secret put MEDIA_ADMIN_TOKEN --config apps/media-admin/wrangler.jsonc
npx wrangler deploy --config apps/media-public/wrangler.jsonc
npx wrangler deploy --config apps/media-admin/wrangler.jsonc
npx wrangler deploy --config apps/media-discovery/wrangler.jsonc
```

Expected: all pending migrations applied, configured sources present, secret stored
without displaying its value, public/admin endpoint URLs and successful discovery
Queue/cron bindings. `secret put` may create the initially absent Worker; this is
an explicitly manual remote step. The discovery deployment starts scheduled work.
No website/dashboard secrets or D1 credentials need changing.

## Next: real standalone Media operations

Use the actual URLs returned by deployment. The commands below are manual examples;
set local variables and never commit or paste credentials into reports.

```sh
export MEDIA_PUBLIC_URL='https://<public-worker-host>'
export MEDIA_ADMIN_URL='https://<admin-worker-host>'
# Set MEDIA_ADMIN_TOKEN securely in this shell.
curl --fail-with-body "$MEDIA_PUBLIC_URL/articles?limit=20"
curl --fail-with-body -H "Authorization: Bearer $MEDIA_ADMIN_TOKEN" "$MEDIA_ADMIN_URL/admin/sources"
curl --fail-with-body -H "Authorization: Bearer $MEDIA_ADMIN_TOKEN" "$MEDIA_ADMIN_URL/admin/runs"
curl --fail-with-body -H "Authorization: Bearer $MEDIA_ADMIN_TOKEN" "$MEDIA_ADMIN_URL/admin/articles?status=approved"
curl --fail-with-body -H "Authorization: Bearer $MEDIA_ADMIN_TOKEN" "$MEDIA_ADMIN_URL/admin/ai-usage"
```

1. After the first scheduled scan, verify a succeeded run, new approved AQN rows,
   `trusted_source_auto`, `standard` review snapshots, no excerpt/body/AI provenance,
   and exactly one `auto_approved` event per new article. Each new scan should record
   known items as updated without duplicate identities or creation events.
2. Confirm public articles are chronologically stable, cursor pages do not overlap,
   limit is capped at 50, and responses omit status/review notes/policy/AI internals.
   Invalid inputs should give bounded 400 errors. Public POST/admin paths must fail.
3. Confirm missing/wrong admin bearer tokens fail, and a different reserved sync
   token cannot authenticate editorial routes. Admin data is never cacheable.
4. On an agreed real article, hide with a fresh idempotency key, repeat the same
   request/key, and inspect the single event plus replay receipt. Rediscover it and
   verify it stays hidden and disappears publicly within the five-minute cache TTL.
   Unhide using a new key. Replay the old hide key and verify the article remains
   approved (the returned old receipt is not a fresh state mutation).
5. Exercise reject/approve with new keys on an agreed real record; verify rejection
   survives rediscovery. Invalid state transitions/key reuse must return 409.
6. Inspect one real scan failure/retry when it naturally occurs or when a bounded
   authorised operational exercise is arranged: approved data must remain intact,
   run error codes must be bounded, and acknowledged work must not be lost. D1
   unavailability can prevent diagnostic persistence; structured logs then remain.
7. Confirm title AI uses only the bounded RSS context, records returned token usage,
   remains within the local neuron budget, and leaves conservative reservations charged
   when usage cannot be reconciled. Missing preview metadata must leave text-only cards
   possible. If a permitted
   preview exists, confirm source/article blocks suppress it without image fetching.
8. Keep the UK AQ website/dashboard disconnected. Observe the standalone service
   without the Pro/MySQL mirror, which is not present or required. Manual-source
   Pending behaviour and live AI-failure behaviour await their later adapter phase.

Example editorial request (repeat the same key only to retry this action):

```sh
export MEDIA_ARTICLE_ID='<agreed-real-article-id>'
export MEDIA_ACTION_KEY="$(uuidgen)"
curl --fail-with-body -X POST -H "Authorization: Bearer $MEDIA_ADMIN_TOKEN" -H "Idempotency-Key: $MEDIA_ACTION_KEY" "$MEDIA_ADMIN_URL/admin/articles/$MEDIA_ARTICLE_ID/hide"
```

Bounded provenance inspection:

```sh
npx wrangler d1 execute MEDIA_DB --remote --config apps/media-discovery/wrangler.jsonc --command 'SELECT article_id, event_type, count(*) AS n FROM media_article_events WHERE event_type = "auto_approved" GROUP BY article_id ORDER BY article_id DESC LIMIT 20'
```

Expected: one creation auto-approval per new AQN identity. Inspect state/receipt/event
changes together; do not treat repeated HTTP 200 receipts as repeated mutations.

## Limitations and rollback

- Feed work is bounded to 20 entries/1 MiB; increased feed size fails visibly. A
  prolonged outage may miss items that leave the feed. No archive/backfill is present.
- Three retries and no dead-letter queue keep V1 to one queue. Exhausted messages
  are discarded; future schedules rescan. Unknown/enrichment message types record
  bounded diagnostics and retry; they are not operational enrichment work.
- A worker interruption may leave a run marked `running`; inspect its age and the
  queue message/attempt evidence. A retry creates a new run. Do not infer success
  from `running`. Counters and article/events commit together on a successful scan.
- No automatic run/AI-ledger retention, immediate public cache purge or historical
  recovery job is included. Review retention before sustained growth.
- Source disablement stops discovery; it does not remove approved articles. Hiding
  an article or blocking its image is an explicit separate editorial decision.
- Source configuration/editing routes and mirror pagination are deferred. Public
  CORS/custom domain and website cut-over need a later explicit integration task.

Before any future deployed upgrade, export D1 for recovery:

```sh
npx wrangler d1 export MEDIA_DB --remote --config apps/media-discovery/wrangler.jsonc --output media-before-upgrade.sql
```

Store the export outside Git. If discovery misbehaves, disable the AQN source in D1
through a separately authorised operator change, then remove the cron/consumer
configuration and deploy that change if necessary. Public approved content remains
in D1. For later Worker upgrades, use `npx wrangler rollback --config
apps/media-discovery/wrangler.jsonc` (and the corresponding public/admin config when
needed) to restore a known prior deployment. Initial deployment has no previous
version to roll back to. Do not drop D1 tables/delete articles to roll back code;
that would destroy authoritative editorial history. Retain D1 and restore/fix
forward through a separately reviewed recovery task.

## Chat-mode documentation handover

No authoritative contract change is required to implement this slice, and no
system-doc file was edited. After deployment, Chat mode should record actual
runtime status, resource identities, successful real-operation evidence and any
approved website cut-over. Potential clarifications to record as implementation
notes: AQN uses standard review snapshots plus trusted-source-auto provenance;
publication cache TTL is five minutes; admin replay receipts describe the original
mutation; and Cloudflare allowance remaining is only a Media-ledger estimate. D1 schema
and API details are available in this repository for that handover.

Deferred: nine publisher adapters, source/text/tag editing, dashboard, Pro/MySQL
pull mirror and sync API, body access/licensing decisions, broader enrichment, title
batching, image crawling/caching, story grouping and public website integration.
