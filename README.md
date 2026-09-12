# UK AQ Media

Standalone repository implementation: three Cloudflare Workers sharing authoritative
D1 state, with Queue-driven Air Quality News, Guardian, BBC News, Sky News and The
Independent RSS discovery. It is not connected to the public UK AQ website.

The behavioural authority is the sibling
[Media contract](../TEST-uk-aq-system-docs/system_docs/media/media_contract.md).
This README describes this implementation, not a replacement contract.

## Workspace

| Area | Contents |
| --- | --- |
| `apps/media-public` | Approved public feed only; `MEDIA_DB` binding |
| `apps/media-admin` | Bearer-authenticated editorial reads/transitions and explicit title generation; `MEDIA_DB`, `AI`, `MEDIA_ADMIN_TOKEN` |
| `apps/media-discovery` | Authenticated scheduler receiver and single Queue consumer; `MEDIA_DB`, `MEDIA_DISCOVERY_QUEUE`, `AI`, `UK_AQ_MEDIA_WORKER_HTTP_SECRET`, and dormant `scheduled()` fallback handler |
| `packages/core` | Shared source/article/policy types, D1 source loading, canonical URL identity, HTTP helpers |
| `packages/discovery` | Shared bounded RSS handling, AQN/Guardian adapters, source-run/article/evidence persistence, typed work messages |
| `packages/enrichment` | Display-title prompt/provider seam, output validation and local/durable AI budgets; automatic generation remains policy-gated and explicit admin generation is separately authorised |
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

`npm run check` validates the seed, focused AI accounting arithmetic and Guardian
image-candidate ranking, typechecks all apps and packages, and bundles each Worker with
`wrangler deploy --dry-run`. It does not deploy. `npm run types` regenerates each Worker's
binding interface from its config.
Wrangler-generated output, dependencies, local databases and local credentials are
ignored by Git. No broad functional test suite has been added.

Seed SQL is `0002_launch_sources.sql`, generated with `npm run seed:generate`.
It is an applied immutable baseline and inserts missing source identities only.
Current source configuration advances through reviewed later migrations; `0003`
moves only AQN's original `discovery_metadata_only` state to
`article_head_allowed`, while `0004` enables the bounded Guardian routes and adds
author-rule/route provenance; `0005` permits Guardian RSS preview images; and `0006`
adds current AI-title suggestion fields/daily reservations and narrowly advances AQN
and Guardian to metadata-only AI. Because `0006` had already reached `main`, `0007`
adds the replacement request-level neuron ledger without rewriting possibly applied
migration history. Any non-zero legacy daily counter is retained as unknown usage and
conservatively charges that UTC day's full local neuron budget. AQN and The Guardian
are enabled alongside the three manual publisher RSS adapters added by `0010`. Migration
`0011` expands those publisher routes, gives The Independent its explicit legacy
`independent.co.uk` domain family, and removes or retires Defra from the current source
catalogue without deleting referenced history. Four publisher adapters remain deferred.

## HTTP surface

Public:

- `GET /articles?limit=20` — default 20, maximum 50; newest first by publication
  time (discovery time when absent), then descending ID.
- `GET /article-images/:id?v=<image-version>` — transiently cached publisher preview bytes
  for a permitted approved article; the SHA-256-derived version changes with the stored
  publisher URL, while the edge TTL remains 24 hours and the upstream limit remains 5 MiB.
- `next_before` is an opaque cursor. URL-encode it as the `before` parameter for
  the next page. No offset pagination or generic query language.

The response includes original headline/link/publisher, an optional publisher
compact display title, available date/author, structured tags, optional UK AQ
editorial fields with their human/AI origin, and a permitted UK AQ cached-preview
URL. Each `preview_image_url` contains the current stored-image version; the proxy derives
and validates that version from D1 rather than trusting arbitrary request query parameters.
Descriptions/bodies and internal fields are absent.
Only approved articles are selected. Successful responses allow five minutes of
caching; errors use `no-store`. No cross-origin integration is configured yet.

Admin requests require `Authorization: Bearer <MEDIA_ADMIN_TOKEN>` and use
`Cache-Control: no-store`:

- `GET /admin/articles?status=pending&limit=20` — optional status, maximum 50;
  status-filtered reads use feed chronology, unfiltered reads use update chronology.
- `GET /admin/sources?limit=20` — maximum 50.
- `GET /admin/runs?limit=20` — most recent runs, maximum 50.
- `GET /admin/ai-usage?limit=20` — current/recent UTC-day Workers AI request,
  title, token and neuron accounting; Cloudflare remaining capacity is explicitly estimated.
- `POST /admin/articles/:id/approve` — pending/rejected to approved.
- `POST /admin/articles/:id/reject` — pending/approved to rejected.
- `POST /admin/articles/:id/hide` — approved to hidden.
- `POST /admin/articles/:id/unhide` — hidden to approved.
- `POST /admin/articles/:id/display-title/accept-ai` — publish the current Pending
  AI suggestion as an AI-origin display title.
- `POST /admin/articles/:id/display-title/reject-ai` — reject the current Pending
  AI suggestion without publishing it.
- `POST /admin/articles/:id/display-title/generate-ai` — explicitly request or refresh one
  pending AI title suggestion for any existing article, using the shared model, prompt,
  request-level neuron ledger and daily Media budget. This does not alter source automatic-AI
  policy, the current display title, article status or approval state.
- `PUT /admin/articles/:id/display-title` with
  `{ "display_title": "Human wording" }` — set/change a human-origin title for any
  article; use `{ "display_title": null }` to clear it and restore publisher-title fallback.
- `POST /admin/articles/:id/guardian-image-refresh/preview` with
  `{ "route_key": "guardian-environment" }` — refetch one bounded current Guardian RSS
  route and return the stored and best permitted publisher-supplied image metadata without
  mutation.
- `POST /admin/articles/:id/guardian-image-refresh/apply` with the previewed `route_key`,
  `expected_current_image_url`, `proposed_image_url`, and
  `"confirm_replace_existing": true` — refetch and revalidate the current RSS proposal,
  then replace that single Guardian article image using a compare-and-swap update.
- `POST /admin/guardian-image-refresh/preview` — fetch each of the eleven configured,
  at-most-ten-item Guardian RSS routes once and return the bounded safe bulk-repair plan plus
  its deterministic `repair_token`, without mutation.
- `POST /admin/guardian-image-refresh/apply` with
  `{ "confirm_bulk_replace": true, "repair_token": "..." }` — rebuild the plan from fresh
  RSS and D1 state, reject a changed token with 409, then apply the still-current plan through
  one bounded compare-and-swap D1 statement.

Every article-status transition POST and explicit AI-title generation POST requires a unique
`Idempotency-Key` of 16–100 ASCII letters, digits,
hyphens or underscores (a UUID is suitable). Reuse the same key when retrying the
same action. A successful replay returns the original receipt with `replayed: true`,
even if another action subsequently changed the article. Reusing a key for another
article/action or requesting an invalid transition returns 409. A missing key is
400. Missing/wrong authentication is 401; unknown articles/routes are 404; storage
failure is 503. The explicit AI request key is incorporated into the durable neuron-ledger
identity, so retrying that request cannot admit a second inference; a completed replay returns
the still-current stored result when available. Status-transition POST bodies are unused. Display-title operations
do not change article status/revision or create article-status audit events; human
titles are single-line and bounded to 500 Unicode characters, not the 64-character
automatic-AI limit.
Guardian image refresh is never scheduled. The bulk path may fill a null image, or replace a
non-null image only when that exact stored URL is still present among the permitted candidates
for the same article in current configured RSS. Existing URLs absent from that candidate set are
reported as `ambiguous_existing_image` and left untouched; articles outside current RSS coverage
are counted and left untouched. Duplicate route sightings merge by canonical URL and cannot
produce duplicate writes. The single-article path remains available for explicit editorial
decisions. Both paths leave article status/revision and events unchanged.

A state change and append-only event commit atomically through SQL triggers.
`MEDIA_SYNC_TOKEN` is reserved for later read-only `/sync` endpoints and is never
accepted by `/admin`; no sync endpoint or MySQL mirror is implemented in this phase.
Source policy editing, UK AQ text/tag editing and dashboard UI are also deferred.

The discovery Worker exposes one authenticated backend scheduling route:

- `POST /scheduler/run` requires `UK_AQ_MEDIA_WORKER_HTTP_SECRET` only through
  `x-uk-aq-worker-http-secret` and returns `202` with `{ "ok": true, "queued": 25 }`
  when all current routes and all three Guardian author rules are enabled: one AQN scan,
  eleven Guardian routes, four BBC routes, four Sky routes and five Independent routes.
  Disabled or structurally mismatched author rules omit only their profile route, so
  `queued` reports the actual bounded message count. The
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
helper that selects only allowlisted AQN, Guardian, BBC News, Sky News and Independent
work when each D1 source is current and enabled. The caller cannot supply source or
route selection. AQN retains its route-less `source_scan`; every Guardian and generic
publisher RSS route receives its own `source_scan`. The consumer reloads and validates
D1 policy and exact adapter routes. Work messages carry identities, never bodies.

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

All new AQN articles are relevant without UK/topic filtering. Its currently seeded
`auto_approve` policy creates them approved with `trusted_source_auto` provenance;
AI does not participate. AQN snapshots `standard` review level because the contract
keeps review levels to standard/enhanced; its configured behaviour is represented by
publication policy and approval method. Source publication policy is authoritative and
prospective: any supported source deliberately set to `auto_approve` applies that rule
to future otherwise-eligible discoveries, while changing a source to `manual` makes
future discoveries Pending. Rediscovery does not apply a source-policy change to an
existing article.

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
only configured exact full-name aliases. An enabled matching author rule takes
precedence over source policy: `auto_approve` uses `trusted_author_auto`, `pending`
remains Pending, and `inherit_source` follows the source rule. Gary Fuller matches use
`trusted_author_auto` plus `approval_author_rule_key='guardian:gary-fuller'`;
Damian Carrington and Fiona Harvey remain Pending under their explicit author rules.
Other Guardian Air Pollution items currently remain Pending because Guardian's source
policy is `manual`; if an operator changes it to `auto_approve`, they instead use
`trusted_source_auto`. A Pending overlap can be promoted once, while Approved,
Rejected and Hidden state is preserved. Per-route evidence records publisher-RSS
provenance, matched author keys and first/last observation counts. Its author-auto flag
is set only on the route whose observation inserted an Approved article or promoted
Pending to Approved;
later overlapping routes do not inherit an earlier auto-approval event. Guardian
article-head/body access remains disabled. For title AI only, the parser extracts the
first HTML paragraph of RSS `description` as transient standfirst context and discards
later paragraphs; `content:encoded` is never exposed.

Guardian RSS image selection validates every candidate against the exact `i.guim.co.uk`
boundary, prefers the largest trustworthy positive declared width, then height, then
`media:content`, image enclosure, `media:thumbnail`, and stable RSS order. Malformed or missing
dimensions provide no size advantage. AQN retains the shared parser's existing candidate order,
and normal rediscovery still fills only null images rather than replacing non-null selections.

BBC uses top, science-and-environment, UK and health feeds, each capped at 20 entries.
Sky uses home, UK, world and technology feeds, each capped at 10 because the official
feeds currently expose no more than that. The Independent uses home and UK feeds capped
at 20 plus climate, science and health feeds capped at 10. Each route is a separate
bounded Queue invocation and uses the shared deterministic AQ relevance filter. The
Independent keeps `the-independent.com` as its canonical domain while the explicit
`independent.co.uk` family (including subdomains such as `static.independent.co.uk`) is
accepted for legacy article/image ownership; unrelated domains remain rejected.

Successful scans atomically persist articles, exactly one creation/auto-approval
event per new identity, and run counters. Runs record bounded codes rather than
feed content/error dumps. Queue acknowledgement follows completion of those writes.
Failures retry after five minutes, at most three times; without a dead-letter queue,
exhausted messages are discarded and the next scheduled scan retries discovery.
A long outage can exceed the feed's recent window; historical recovery is deferred.

AQN and Guardian allow metadata-only AI for the narrow display-title task. The three
manual publisher RSS sources and four deferred publishers retain disabled AI. No seed
asserts a permanent legal permission; Defra is retired from the current Media source
catalogue.
Source-level and article-level image blocks are both checked on public reads.

Automatic display-title AI runs only for accepted AQN/Guardian feed items whose stored
publisher title exceeds 64 Unicode characters, whose current status is Pending or
Approved, and which have neither a display title nor a previous automatic attempt/current
suggestion. It uses only publisher name, original title, the bounded source-specific RSS
context, author and bounded RSS categories. Discovery commits before inference; title
AI never participates in relevance, approval or article-state decisions.

Workers AI uses configured model `MEDIA_AI_MODEL` (initially
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), prompt version
`media-display-title-v2`, temperature 0, JSON-schema output and a 64-token response
bound, with each inference aborted after 20 seconds. Local validation rejects empty, malformed, multiline, control-character or
over-64-character output. Suggestions remain Pending/internal until accepted, while
public responses continue exposing only `display_title` plus the original `title`.
`MEDIA_AI_MAX_REQUESTS_PER_RUN=10` is only a per-scan runaway safeguard. Before each
single-title inference, one atomic D1 statement reserves a conservative estimate against
`MEDIA_AI_DAILY_NEURON_BUDGET=8000`; the request shape, 64-token output allowance and
configured model rates drive that estimate. The initial Llama model uses 26,668 input
and 204,805 output neurons per million tokens. Accounting stores integer millionths of
a neuron and reconciles the reservation to Workers AI's usable prompt/completion/total
token usage. Missing or malformed usage and failed reconciliation retain the reservation.
`MEDIA_AI_ACCOUNT_FREE_NEURONS_PER_DAY=10000` is reported separately as an estimated
Cloudflare allowance, not an authoritative account balance. Unknown model rates disable
automatic title AI. `MEDIA_AI_MAX_TITLES_PER_REQUEST=5` preserves a future batch boundary,
but this phase deliberately sends one title per request. Budget, capacity, output or
storage failure cannot fail discovery, and there is no paid-provider fallback. The
pre-existing generic summary/`why_it_matters` path remains unsupported and disabled.

See the [phase handover](docs/phase-1-handover.md) for manual resource wiring,
real-operation validation, known limits and rollback.
