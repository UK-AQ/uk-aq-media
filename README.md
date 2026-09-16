# UK AQ Media

## DSAWSP publisher source

Doctors and Scientists Against Wood Smoke Pollution is an enabled, manual-review publisher
source. Scheduled discovery reads at most 20 newest `/blog/...` links from its first-party
"Wood smoke news and extras" index. Each candidate receives one bounded, publisher-domain-only
HTML metadata read for its title, `.blog-date`, `.category-link`, and head preview image; no body
copy is retained or sent to AI. DSAWSP Webflow previews may use only the exact
`cdn.prod.website-files.com` hostname and continue through the normal remote-preview proxy.

Standalone repository implementation: three Cloudflare Workers sharing authoritative
D1 state, with Queue-driven Air Quality News, Guardian, BBC News, Sky News and The
Independent RSS discovery, specialist Carbon Brief, OpenAQ and Phys.org feeds, a bounded
DSAWSP publisher-index adapter, and a
separate global GDELT Web NGrams batch that retains English AQ candidates globally but
promotes only relevant UK-publisher candidates into the existing Media system.
The public website reaches the approved homepage feed only through the sibling
cache proxy; browser code has no Media credentials or direct Media origin access.

The behavioural authority is the sibling
[Media contract](../TEST-uk-aq-system-docs/system_docs/media/media_contract.md).
This README describes this implementation, not a replacement contract.

## Workspace

| Area | Contents |
| --- | --- |
| `apps/media-public` | Approved public feed only; `MEDIA_DB` binding |
| `apps/media-admin` | Bearer-authenticated editorial reads/transitions and explicit title generation; `MEDIA_DB`, `AI`, `MEDIA_ADMIN_TOKEN` |
| `apps/media-discovery` | Authenticated scheduler receiver, fixed-schema GDELT ingestion boundary and single Queue consumer; `MEDIA_DB`, `MEDIA_DISCOVERY_QUEUE`, `AI`, two dedicated HTTP secrets, and dormant `scheduled()` fallback handler |
| `packages/core` | Shared source/article/policy types, D1 source loading, canonical URL identity, HTTP helpers |
| `packages/discovery` | Shared bounded RSS handling, AQN/Guardian adapters, source-run/article/evidence persistence, typed work messages |
| `packages/gdelt` | Global Web NGrams windowing, strong-family matching, streaming Node scanner and D1 candidate/UK-promotion operations |
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
catalogue without deleting referenced history. Migration `0012` adds Carbon Brief,
OpenAQ and Phys.org as manual/Standard generic RSS publishers. `0013` initializes the
generation-backed homepage latest-six state. `0014` adds GDELT checkpoint,
run/file/chunk evidence, global candidate/family state and the conservative publisher-domain
scope registry; `0015` adds separate malformed NGram accounting; and `0016` advances only
still-blocked GDELT dynamic publisher sources to `remote_preview`. Four publisher adapters
remain deferred.

## GDELT Web NGrams discovery

`.github/workflows/uk_aq_media_gdelt.yml` supports manual dispatch and is dispatched by the
TEST Ops central scheduler at minutes 10, 25, 40 and 55 each hour. It has no native GitHub
Actions Cron, so the Ops job is the sole scheduling authority; the separate Media RSS discovery
job remains a two-hour `worker_http` route. One concurrency group prevents overlapping workflow
runs. The Node 22 batch
streams and gunzips paired minute objects from GDELT's Web NGrams bucket; it does not use the
GDELT DOC API and does not scan bulk files inside a Worker or `/scheduler/run`.

The run uses a dedicated secret-authenticated backend boundary on `media-discovery`. Its
fixed routes accept only strict run, file, candidate-chunk, completion and failure shapes;
they cannot select SQL or invoke generic database work. D1 owns the checkpoint and all
candidate/article state. The runner holds only the current file's matched DOCID map and
candidate chunk data.

Exact bounds are a five-minute safety lag, 120-minute initial lookback, 15-minute overlap,
at most 240 new catch-up minutes and six new complete pairs per run. Limits are 200 matched
candidates/file, 600/run and two candidates per 128 KiB ingestion request. HEAD, file and
ingestion timeouts are 15, 120 and 30 seconds. Compressed caps are 96 MiB for NGram and
64 MiB for TOC; each decompressed stream is capped at 768 MiB. Raw decompressed-line framing
ceilings are 128 KiB for NGram and 1 MiB for TOC. The larger NGram framing allowance does not
make 128 KiB quadgrams valid: accepted quadgrams remain capped semantically at 4,096 characters.
Article URLs are HTTPS-only and capped at 2,048 characters; titles at 1,000 characters.
Both objects missing is normal. Partial pairs and structurally broken files fail without
advancing past undurable work.

The four normalised families are `gdelt-wood-burning`, `gdelt-wildfire`,
`gdelt-air-pollution` and `gdelt-air-quality`. Candidates deduplicate by the existing Media
canonical URL hash and retain provider-observation/file/family provenance separately from
`media_articles`. TOC `date` never becomes `published_at`, and TOC `img` is ignored.
Explicit domain scope wins, then registrable `.uk` is UK; generic TLDs remain unknown unless
mapped. Relevant UK candidates reuse configured publisher policy. An unknown UK domain gets
one deterministic disabled manual/Enhanced metadata-only source with AI disabled and
`image_policy='remote_preview'`. That image policy permits only bounded presentation-metadata
retrieval and validated remote preview use; it does not enable article-body retrieval, AI,
local image copying, ordinary source discovery, source enablement or automatic approval.
Non-UK, unknown and relevance-filtered candidates stay outside article/editorial/public
state. Promotions use shared article persistence and homepage latest-six reconciliation;
candidate-only writes cannot change the homepage generation.

Required GitHub configuration is `UK_AQ_MEDIA_GDELT_INGEST_URL` as a repository variable and
the same new `UK_AQ_MEDIA_GDELT_INGEST_SECRET` value as both a repository secret and discovery
Worker secret. The deployment workflow applies the Worker secret before deploying discovery.
`npm run gdelt:check` is the focused deterministic fixture; `npm run gdelt:run` is the real
batch entrypoint.

## HTTP surface

Public:

- `GET /articles?limit=20` — default 20, maximum 50; newest first by publication
  time (discovery time when absent), then descending ID.
- `GET /articles/homepage/version` — no-store generation discovery for the homepage's
  exact current six approved articles. `GET /articles/homepage?generation=<n>` serves
  that fixed snapshot only when `n` is current; it returns 409 otherwise and uses an
  immutable 24-hour edge cache entry keyed by the generation. The generation advances
  only when that ordered six-item public snapshot changes.
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
caching; errors use `no-store`. Browser access remains same-origin through the cache proxy.

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
  `x-uk-aq-worker-http-secret` and returns `202` with `{ "ok": true, "queued": 29 }`
  when all current routes and all three Guardian author rules are enabled: one AQN scan,
  eleven Guardian routes, four BBC routes, four Sky routes, five Independent routes and
  one route for each RSS specialist publisher, and one DSAWSP publisher-index route.
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
work, plus Carbon Brief, OpenAQ, Phys.org and DSAWSP, when each D1 source is current and enabled.
The caller cannot supply source or
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

Carbon Brief uses `https://www.carbonbrief.org/feed/`, with only its exact current
same-publisher redirect to `https://www.carbonbrief.org/feed` permitted. OpenAQ uses
`https://openaq.medium.com/feed`; its emitted article host `openaq.medium.com` is the
canonical source domain. Only the OpenAQ route opts into transient inspection of the first
64 KiB of each RSS `content:encoded` value. It retains only the first suitable validated
image URL on exact host `cdn-images-1.medium.com`; explicit 1x1 images and all other hosts,
including Medium's tracking-pixel host, are rejected. The body HTML is discarded and is not
persisted, exposed, used for relevance/title generation or supplied to AI. A valid RSS image
also prevents the normal missing-preview article-head fallback, so Medium article-page HTTP
403 responses are irrelevant for those observations. Phys.org uses
`https://phys.org/rss-feed/earth-news/environment/`. All three use the generic publisher
RSS adapter, remain manual/Standard, retain no excerpt, and pass the deterministic AQ
relevance filter. Carbon Brief and OpenAQ permit metadata-only display-title AI;
Phys.org keeps title AI disabled so its original headlines remain observable. Discovery
always stores the original feed headline in `title`, leaves `display_title` null, and does
not invoke AI for any of these three sources. Carbon Brief and OpenAQ remain eligible for
an explicit authenticated editorial title request; any resulting suggestion stays
separately Pending until editorial acceptance.

Article canonical-domain validation remains separate from preview-image validation.
OpenAQ article identity stays restricted to `openaq.medium.com`; only its preview policy
permits exact host `cdn-images-1.medium.com`.
Admin **Reload metadata** is source-aware: OpenAQ reloads its configured
`openaq-medium` RSS route, matches the existing article by canonical URL and uses that
bounded RSS observation for its title/author/date/preview proposal. It does not fetch
the Medium article page, whose bounded article-head response is expected to be 403.
The OpenAQ RSS `content:encoded` scan remains limited to the first suitable permitted
image URL; body HTML is discarded and is not exposed, persisted or supplied to AI.
Phys.org article identity stays restricted to `phys.org`; its preview-image policy also
permits the exact observed publisher image host `scx2.b-cdn.net`. No `b-cdn.net` wildcard
or other CDN hostname is accepted. Guardian's existing exact `i.guim.co.uk` exception uses
the same centralized source-specific preview-host mechanism.

Successful scans atomically persist articles, exactly one creation/auto-approval
event per new identity, and run counters. Runs record bounded codes rather than
feed content/error dumps. Queue acknowledgement follows completion of those writes.
Failures retry after five minutes, at most three times; without a dead-letter queue,
exhausted messages are discarded and the next scheduled scan retries discovery.
A long outage can exceed the feed's recent window; historical recovery is deferred.

AQN and Guardian retain automatic metadata-only AI for the narrow display-title task.
Carbon Brief and OpenAQ permit the same bounded metadata use only through an explicit
authenticated editorial request; discovery does not call AI for them. Phys.org, the three
mainstream manual publisher RSS sources and four deferred publishers retain disabled AI. No seed
asserts a permanent legal permission; Defra is retired from the current Media source
catalogue.
Source-level and article-level image blocks are both checked on public reads.

Automatic display-title AI runs only for accepted AQN/Guardian feed items whose stored
publisher title exceeds 66 Unicode characters, whose current status is Pending or
Approved, and which have neither a display title nor a previous automatic attempt/current
suggestion. It uses only publisher name, original title, the bounded source-specific RSS
context, author and bounded RSS categories. Discovery commits before inference; title
AI never participates in relevance, approval or article-state decisions.

Workers AI uses configured model `MEDIA_AI_MODEL` (initially
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), prompt version
`media-display-title-v3`, temperature 0, JSON-schema output and a 64-token response
bound, with each inference aborted after 20 seconds. Local validation rejects empty, malformed, multiline, control-character or
over-66-character output. Successful routine suggestions are accepted immediately as AI-origin display titles while
retaining the accepted suggestion and full model, prompt and timestamp provenance. Historical
or explicitly generated Pending suggestions remain available to the manual Accept/Reject controls.
Public responses continue exposing only `display_title` plus the original `title`.
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

## Bluesky article publishing

Bluesky publication is a downstream, durable outbox operation and never changes an
article's Media approval result. Migration `0021_bluesky_publications.sql` adds the
singleton `media_bluesky_settings`, the audited `media_bluesky_publications` outbox,
the full-identity `media_admin_status_requests` idempotency receipts, and explicit
`media_source_social_accounts` identities. It installs an approval-event trigger but
seeds publishing disabled with no activation watermark, so installation does not
backfill or publish historical approvals.

Media owns Bluesky policy, state, and the authenticated API; the separate Ops
repository owns the visible Articles dashboard and modal presentation. The Media API
exposes `GET` and `PUT /admin/bluesky/settings`. `GET` returns safe saved state,
template/post/cooldown constraints, the saved template's literal grapheme count, and
fixed example values for the Ops preview. `PUT`
requires the normal bearer credential and an `Idempotency-Key`, and accepts only
`publishing_enabled`, `default_message_template`, and `cooldown_minutes` (1–1,440).
The first deliberate enable atomically captures the highest article-event id; later
disable/re-enable operations retain that watermark. Disabling is the publishing kill
switch and leaves the durable backlog intact.

Future approval events create an automatic outbox row only for `auto_approved`, or
`approved` from `pending`, and only when the article and source both permit the stored
remote-preview thumbnail. Rejected-to-approved and hidden-to-approved remain ordinary
Media transitions unless their existing status endpoint receives
`{"post_to_bluesky":true}`. That option defaults false, is rejected without an eligible
thumbnail, and uses the admin request identity for replay-safe but repeatable deliberate
reposts. The request receipt stores article, action, and `post_to_bluesky` together in the
same transactional batch as the event/outbox change, so same-key conflicts fail without
borrowing another request's event. Article detail returns exact successful-post and
publication counts, bounded history, latest status, thumbnail eligibility, and
current-state manual-repost availability/reason so Ops does not duplicate Media
eligibility policy; list responses retain both counts and latest status.
`post_count`/`bluesky_post_count` count only `posted` records that exist on Bluesky;
`publication_count`/`bluesky_publication_count` count every durable outbox row.

Post text is the accepted display title (otherwise publisher title), one blank line,
then the global template. Supported placeholders are `{publisher}` and
`{publisher_mention}`; mentions come only from explicit source identities. Unknown
placeholders are rejected. Template literals are limited to 120 Unicode graphemes;
the complete expanded post is limited to 300 graphemes and 3,000 UTF-8 bytes, with only
the rendered title deterministically shortened. The seeded template is:

```text
From {publisher} {publisher_mention}

Live and historical UK air quality data:
https://ukaq.co.uk/
```

`uk-aq-media-bluesky` is a dedicated serialized Queue, produced by admin and discovery
as `MEDIA_BLUESKY_QUEUE` and consumed by `media-discovery`. Queue messages are bounded
wake-ups only; D1 selects the oldest queued id. The default ten-minute cooldown is
computed from `last_successful_post_at`. Delayed Queue wakes enforce it, while the active
central `POST /scheduler/run` two-hour path, the dormant native scheduler fallback,
and post-discovery reconciliation recover lost wake-ups. A stale `posting` claim is
recovered after ten minutes. Transient retry eligibility is persisted as `next_attempt_at`,
so an early duplicate wake cannot bypass bounded exponential backoff. Success and terminal
failure both schedule the next eligible backlog wake; only successful posts start cooldown.
A non-stale `posting` claim is a global backlog barrier: no later queued publication is
claimed until that claim resolves or reaches its ten-minute stale-recovery threshold.
The earliest live claim schedules the next wake for that threshold (subject to any
successful-post cooldown), rather than allowing an immediately eligible queued row to
force an early wake. This preserves durable oldest-first processing and cooldown safety
across the remote-success/D1-crash window, while avoiding a two-hour reconciliation wait.

The consumer reuses the existing source-scoped remote-preview validator/fetcher, accepts
only a bounded current image type/size, uploads a blob, and always creates an explicit
`app.bsky.embed.external` card for the canonical publisher URL. It calls the AT Protocol
XRPC endpoints directly (session, blob upload, and `com.atproto.repo.createRecord`) with
a common 15-second timeout covering both the request and bounded JSON body consumption to
avoid a larger runtime SDK. Each publication persists a valid deterministic TID record
key before the remote write; retries read that same record after an existing-record
response, closing the remote-write/D1 crash duplicate window. Bounded failure codes are
stored; no raw upstream body or credential is persisted or logged.
Authentication rate limiting (`429`), provider `5xx`, network failures and timeouts are
transient; definite invalid credentials remain the permanent `bluesky_auth_failed` code.
The existing ten-second thumbnail timeout likewise remains active through image-body
consumption, with the source policy and one-megabyte bound unchanged.

Deployment requires the operator to create `uk-aq-media-bluesky`, add GitHub repository
secret `UK_AQ_MEDIA_BLUESKY_APP_PSWD`, apply the forward D1 migration, and deploy through
the existing workflow. The workflow adds this secret to the existing in-memory `jq` /
`wrangler secret bulk` discovery Worker step. Publishing remains disabled after deploy;
the operator must deliberately perform first activation. Roll back outbound publishing
by disabling the setting first; do not delete audit rows. Existing posts are not deleted.

After TEST deployment, validate settings presentation with fixed dummy preview data,
template counters, one thumbnail-backed Pending approval, one auto-approval, no-image
exclusion, checked and unchecked rejected/hidden restores, idempotent request replay,
oldest-first cooldown, deterministic title shortening, external cards, URI/CID retention,
bounded failures, and scheduler reconciliation. Do not validate by posting before the
operator has deliberately activated TEST.
