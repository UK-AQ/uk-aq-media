# UK AQ Media

Standalone repository implementation: three Cloudflare Workers sharing authoritative
D1 state, with Queue-driven Air Quality News and Guardian RSS discovery. It is not
connected to the public UK AQ website.

The behavioural authority is the sibling
[Media contract](../TEST-uk-aq-system-docs/system_docs/media/media_contract.md).
This README describes this implementation, not a replacement contract.

## Workspace

| Area | Contents |
| --- | --- |
| `apps/media-public` | Approved public feed only; `MEDIA_DB` binding |
| `apps/media-admin` | Bearer-authenticated editorial reads/transitions; `MEDIA_DB`, `MEDIA_ADMIN_TOKEN` |
| `apps/media-discovery` | Authenticated scheduler receiver and single Queue consumer; `MEDIA_DB`, `MEDIA_DISCOVERY_QUEUE`, `AI`, `UK_AQ_MEDIA_WORKER_HTTP_SECRET`, and dormant `scheduled()` fallback handler |
| `packages/core` | Shared source/article/policy types, D1 source loading, canonical URL identity, HTTP helpers |
| `packages/discovery` | Shared bounded RSS handling, AQN/Guardian adapters, source-run/article/evidence persistence, typed work messages |
| `packages/enrichment` | Policy-gated display-title prompt/provider seam, output validation and local/durable AI budgets; broader enrichment remains disabled |
| `migrations` | Core tables/indexes/triggers, immutable initial source seed and forward policy/schema changes |
| `config/sources.seed.json` | Current target source permission/discovery posture |
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
It is an applied immutable baseline and inserts missing source identities only.
Current source configuration advances through reviewed later migrations; `0003`
moves only AQN's original `discovery_metadata_only` state to
`article_head_allowed`, while `0004` enables the bounded Guardian routes and adds
author-rule/route provenance; `0005` permits Guardian RSS preview images; and `0006`
adds current AI-title suggestion fields/daily reservations and narrowly advances AQN
and Guardian to metadata-only AI. AQN and The Guardian are enabled; the other eight
adapters remain deferred.

## HTTP surface

Public:

- `GET /articles?limit=20` — default 20, maximum 50; newest first by publication
  time (discovery time when absent), then descending ID.
- `GET /article-images/:id` — transiently cached publisher preview bytes for a
  permitted approved article; 24-hour edge TTL and a 5 MiB upstream limit.
- `next_before` is an opaque cursor. URL-encode it as the `before` parameter for
  the next page. No offset pagination or generic query language.

The response includes original headline/link/publisher, an optional publisher
compact display title, available date/author, structured tags, optional UK AQ
editorial fields with their human/AI origin, and a permitted UK AQ cached-preview
URL. Descriptions/bodies and internal fields are absent.
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
- `POST /admin/articles/:id/display-title/accept-ai` — publish the current Pending
  AI suggestion as an AI-origin display title.
- `POST /admin/articles/:id/display-title/reject-ai` — reject the current Pending
  AI suggestion without publishing it.
- `PUT /admin/articles/:id/display-title` with
  `{ "display_title": "Human wording" }` — set/change a human-origin title for any
  article; use `{ "display_title": null }` to clear it and restore publisher-title fallback.

Every article-status transition POST requires a unique `Idempotency-Key` of 16–100 ASCII letters, digits,
hyphens or underscores (a UUID is suitable). Reuse the same key when retrying the
same action. A successful replay returns the original receipt with `replayed: true`,
even if another action subsequently changed the article. Reusing a key for another
article/action or requesting an invalid transition returns 409. A missing key is
400. Missing/wrong authentication is 401; unknown articles/routes are 404; storage
failure is 503. Status-transition POST bodies are unused. Display-title operations
do not change article status/revision or create article-status audit events; human
titles are single-line and bounded to 500 Unicode characters, not the 64-character
automatic-AI limit.

A state change and append-only event commit atomically through SQL triggers.
`MEDIA_SYNC_TOKEN` is reserved for later read-only `/sync` endpoints and is never
accepted by `/admin`; no sync endpoint or MySQL mirror is implemented in this phase.
Source policy editing, UK AQ text/tag editing and dashboard UI are also deferred.

The discovery Worker exposes one authenticated backend scheduling route:

- `POST /scheduler/run` requires `UK_AQ_MEDIA_WORKER_HTTP_SECRET` only through
  `x-uk-aq-worker-http-secret` and returns `202` with `{ "ok": true, "queued": 12 }`
  when all three Guardian author rules are enabled: one AQN scan plus eleven Guardian
  route scans. Disabled or structurally mismatched author rules omit only their profile
  route, so `queued` reports the actual bounded message count. The
  count reflects only enabled, internally configured supported work and may be zero.
- Authentication failure returns `401` before any D1 or Queue access. Other methods
  on that path return `405` with `Allow: POST`; unknown paths return `404`.
- Request data cannot select a source, choose a message type or inject arbitrary
  Queue work. The body is ignored and the route only initiates the existing bounded
  Queue-based scheduled-discovery path.
- D1 or Queue failure records/logs `discovery_schedule_failed` and returns `503`
  without exposing exception or secret details.

`workers.dev` is enabled for `media-discovery` solely so the central scheduler in
another Cloudflare account can reach this authenticated endpoint. The TEST central
scheduler path has been operationally proven through repeated real five-minute
validation dispatches and now runs the Media job at the normal two-hour cadence
`0 */2 * * *`.

The previous native Media `*/30 * * * *` Cron trigger was removed from Cloudflare
and from `apps/media-discovery/wrangler.jsonc`, so normal Media deployment will not
recreate it. The `scheduled()` handler remains in code as a dormant fallback and
shares the same bounded enqueue helper, but there is no active native Media Cron.

`UK_AQ_MEDIA_WORKER_HTTP_SECRET` remains a required Cloudflare Worker secret. Its
value is stored as an encrypted GitHub Actions repository secret, never in source
or Wrangler vars. The Media deployment workflow constructs an in-memory JSON
payload and uses the standard UK AQ `wrangler secret bulk` pattern to apply only
this secret to `uk-aq-media-discovery` immediately before deploying that Worker.
Changing the GitHub Actions secret and running a normal Media deployment therefore
restores or updates the discovery Worker secret. Other Worker secrets, especially
`MEDIA_ADMIN_TOKEN`, retain their existing management path.

## Discovery and policy boundaries

The authenticated scheduling route and dormant `scheduled()` fallback share one
helper that selects only allowlisted AQN and Guardian work when each D1 source is
enabled. The caller cannot supply source or route selection. AQN retains its
route-less `source_scan`; Guardian receives one `source_scan` per configured general
route and per enabled, structurally matching profile route. The consumer reloads and
validates D1 policy and exact adapter routes. Work messages carry identities, never
bodies.

Each AQN scan fetches `https://airqualitynews.com/feed/`, with no redirect
following, a 20-second timeout, a 1 MiB limit and at most 20 recent entries. It
rejects XML entity declarations and always excludes `content:encoded`. It extracts
only a transient, at-most-600-character leading RSS-description context for title
AI, preferring the last complete sentence within that bound; it does not persist the
description. When a permitted preview remains missing, it may also
fetch the canonical AQN article with redirects disabled, a 10-second timeout and a
256 KiB limit, stopping and cancelling as soon as `</head>` is obtained. Only
publisher social image/title metadata is extracted; article bodies and descriptions
remain unavailable and image bytes are not fetched by discovery.

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

Guardian uses the Gary Fuller, Damian Carrington and Fiona Harvey profile RSS feeds,
the direct Guardian Air Pollution feed, and seven broader Environment, Pollution,
UK, World, Climate Crisis, Science and Technology feeds. Each of the eleven routes
is limited to 10 entries and runs as separate Queue work. The shared RSS boundary
uses a 1 MiB limit, 20-second timeout and `redirect: 'manual'`. The Environment and
Technology endpoints currently redirect; only their exact configured same-publisher
canonical targets are accepted for one explicit bounded second request. All other
redirects and redirect chains fail closed.

Profile feeds bypass relevance because route identity is strong author evidence,
and Air Pollution is directly in scope. The seven broader routes retain only items
that match the deterministic metadata-only AQ filter or an `always_include` author
rule; they do not require a profile rule for their route, and run rows record
`items_filtered`. Stale profile work whose rule was disabled or removed is recorded
as skipped and acknowledged without fetching the feed. Broader-feed bylines match
only configured exact full-name aliases. Gary Fuller matches use
`trusted_author_auto` plus `approval_author_rule_key='guardian:gary-fuller'`;
Damian Carrington, Fiona Harvey and other Guardian Air Pollution items remain
Pending. A Pending overlap can be promoted once, while Approved, Rejected and Hidden
state is preserved. Per-route evidence records publisher-RSS provenance, matched
author keys and first/last observation counts. Its author-auto flag is set only on the
route whose observation inserted an Approved article or promoted Pending to Approved;
later overlapping routes do not inherit an earlier auto-approval event. Guardian
article-head/body access remains disabled. For title AI only, the parser extracts the
first HTML paragraph of RSS `description` as transient standfirst context and discards
later paragraphs; `content:encoded` is never exposed.

Successful scans atomically persist articles, exactly one creation/auto-approval
event per new identity, and run counters. Runs record bounded codes rather than
feed content/error dumps. Queue acknowledgement follows completion of those writes.
Failures retry after five minutes, at most three times; without a dead-letter queue,
exhausted messages are discarded and the next scheduled scan retries discovery.
A long outage can exceed the feed's recent window; historical recovery is deferred.

AQN and Guardian allow metadata-only AI for the narrow display-title task. The eight
unimplemented sources retain disabled AI. No seed asserts a permanent legal
permission; Defra richer/OGL processing remains disabled pending its adapter work.
Source-level and article-level image blocks are both checked on public reads.

Automatic display-title AI runs only for accepted AQN/Guardian feed items whose stored
publisher title exceeds 64 Unicode characters, whose current status is Pending or
Approved, and which have neither a display title nor a previous automatic attempt/current
suggestion. It uses only publisher name, original title, the bounded source-specific RSS
context, author and bounded RSS categories. Discovery commits before inference; title
AI never participates in relevance, approval or article-state decisions.

Workers AI uses configured model `MEDIA_AI_MODEL` (initially
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), prompt version
`media-display-title-v1`, temperature 0, JSON-schema output and a 64-token response
bound, with each inference aborted after 20 seconds. Local validation rejects empty, malformed, multiline, control-character or
over-64-character output. Suggestions remain Pending/internal until accepted, while
public responses continue exposing only `display_title` plus the original `title`.
`MEDIA_AI_MAX_CALLS_PER_RUN=10` is enforced per source scan and
`MEDIA_AI_MAX_CALLS_PER_DAY=50` is atomically reserved by UTC day in D1. Budget,
capacity, output or storage failure cannot fail discovery, and there is no paid-provider
fallback. The pre-existing generic summary/`why_it_matters` enrichment path remains
unsupported and disabled.

See the [phase handover](docs/phase-1-handover.md) for manual resource wiring,
real-operation validation, known limits and rollback.
