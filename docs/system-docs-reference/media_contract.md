# UK AQ Media contract

**Status:** Current implementation/runtime authority. Standalone Media is deployed; direct publisher discovery has expanded beyond the initial AQN and Guardian adapters; the authenticated TEST central-scheduler path is operational; the native Media Cron trigger has been removed; Communities Against Woodsmoke is an approved next direct source addition but is not current runtime until its Media implementation is deployed and accepted through real operation; public/LIVE UK AQ website integration has not yet cut over.

## 1. Purpose

UK AQ Media discovers air-quality and air-pollution coverage, maintains an editorial review state, and exposes approved material through its standalone public Media API for the future public **AQ in the News** feature.

The navigation label is **AQ NEWS**.

The subsystem is additive. Failure or absence of Media MUST NOT prevent the normal UK AQ website, map, charts, ingest, AQI/WHO products or other core services from operating.

## 2. Runtime ownership and source of truth

The runtime implementation belongs in private repository `TEST-uk-aq/uk-aq-media`.

Cloudflare D1 MUST be the authoritative Media state store.

The MacBook Pro/MySQL database MAY contain a Media mirror for dashboard reads, reporting and later aggregates, but it MUST NOT be authoritative and MUST NOT be required for:

- discovery;
- article/publication state;
- public API serving;
- normal UK AQ operation.

The Pro MUST pull its mirror from an authenticated Media API. Cloudflare MUST NOT require a connection into the home MySQL service.

Editorial mutations MUST be applied to D1 through the Media admin interface. General two-way D1/MySQL replication is prohibited.

## 3. Deployment model

UK AQ Media uses one real service rather than permanent TEST and LIVE copies.

Temporary TEST resources MAY be created for a later significant change when useful, validated through real operation, then retired after the real service is updated.

Public website integration MUST occur only after the standalone Media service has operated successfully with real content.

### 3.1 Current standalone deployment

As of **10 September 2026**, the standalone service is deployed in the dedicated Cloudflare account **UK AQ Media** with:

- D1 database `uk-aq-media`;
- Queue `uk-aq-media-discovery`;
- Worker `uk-aq-media-public`;
- Worker `uk-aq-media-admin`;
- Worker `uk-aq-media-discovery`.

`media-public`, `media-admin` and `media-discovery` are available through the account `workers.dev` subdomain. The deployed `media-discovery` Worker exposes the authenticated backend receiver at:

```text
POST https://uk-aq-media-discovery.uk-aq-media.workers.dev/scheduler/run
```

The receiver MUST accept the dedicated secret only from `x-uk-aq-worker-http-secret`, MUST authenticate before D1 or Queue access, MUST ignore request-body work selection, and MUST be able to enqueue only the bounded scheduled discovery work selected by Media itself. The actual secret value MUST remain a Cloudflare Worker secret and MUST NOT be stored in source, Wrangler vars, D1 or scheduler job configuration.

`UK_AQ_MEDIA_WORKER_HTTP_SECRET` is also stored as an encrypted GitHub Actions repository secret in both the Media repository and the TEST ops repository. Normal Media deployment applies it only to `uk-aq-media-discovery` using the established UK AQ `wrangler secret bulk` path. Normal TEST scheduler deployment applies the same value to `uk-aq-cron-scheduler-ops`. The secret value MUST NOT be committed to either repository.

The current Media implementation can schedule direct discovery for Air Quality News, The Guardian, BBC News, Sky News, The Independent, Carbon Brief, OpenAQ, Phys.org and DSAWSP when the corresponding source is enabled and structurally configured. Communities Against Woodsmoke is the next approved direct source addition and MUST NOT be described as deployed until its Media configuration, migration and scheduling allowlist change have been deployed and accepted through real operation.

AQN discovery uses its RSS feed, auto-approves under the trusted-source exception, permits bounded article-head preview-metadata retrieval under the narrower preview contract, and does not depend on AI.

The Guardian uses eleven bounded overlapping RSS route work units when all three configured author rules are enabled: three author-profile routes, the Air Pollution route, and seven broader filtered routes. The Guardian source remains `manual` / `standard`; Gary Fuller's explicit author rule is the narrow auto-approval exception. Guardian discovery remains metadata-only and AI-disabled. Guardian RSS-supplied preview images are permitted only under the narrower `media-guardian-rss-preview-contract.md` source-specific policy.

BBC News, Sky News, The Independent, Carbon Brief, OpenAQ and Phys.org use bounded direct RSS discovery through the generic publisher RSS path. DSAWSP uses its bounded first-party publisher-index adapter. These direct specialist/publisher sources remain subject to their configured manual publication and review policies unless a narrower explicit rule says otherwise.

Workers AI is bound for later policy-permitted use, but live AI inference is currently disabled by configuration.

The current normal discovery cadence is **every two hours** (`0 */2 * * *`) through the TEST central scheduler. The Media-native Cron trigger has been removed from Cloudflare and from `apps/media-discovery/wrangler.jsonc`, so normal Media deployment will not recreate it. The dormant `scheduled()` handler MAY remain in code as a fallback capability.

During standalone operation the Media job belongs in the **TEST** central scheduler. When Media moves to public/LIVE operation, the equivalent job MUST move to the **LIVE** central scheduler. The central scheduler's existing independent Cloudflare-Cron and MacBook Pro watchdog trigger paths may both attempt the same minute, with the scheduler's atomic minute-slot claim preventing duplicate scheduler execution.

Relevant pushes to `main` in `TEST-uk-aq/uk-aq-media` automatically validate, apply outstanding D1 migrations, apply the required Media scheduling secret to `media-discovery`, and deploy all three Workers through `.github/workflows/uk_aq_media_deploy.yml`. Deployment authentication uses the repository variable `UK_AQ_MEDIA_CLOUDFLARE_ACCOUNT_ID` and repository secrets `UK_AQ_MEDIA_CFLARE_API_TOKEN` and `UK_AQ_MEDIA_WORKER_HTTP_SECRET`. `MEDIA_ADMIN_TOKEN` retains its existing separately managed path.

### 3.2 Current real-operation evidence

AQN and the initial Guardian adapter have both succeeded through the deployed Queue consumer, and the authenticated cross-account central-scheduler path is operationally proven.

As of 10 September 2026, real-operation evidence has confirmed that:

- a real `source_scan` Queue message reaches the discovery consumer;
- the consumer fetches and parses the configured AQN RSS feed;
- the first successful AQN scan inserted its articles and auto-approved them with `approval_method=trusted_source_auto`;
- repeated AQN scans update the existing article observations rather than creating duplicate article identities;
- retrying previously failed Queue messages does not duplicate stored articles;
- the public `GET /articles` endpoint exposes approved rows;
- the authenticated admin API exposes authoritative D1 article and discovery-run state;
- AQN remains fully usable with AI disabled and generated editorial fields unset;
- the TEST central scheduler can authenticate across Cloudflare accounts to `POST /scheduler/run`;
- with AQN plus all three enabled Guardian author rules, the receiver queues 12 bounded work units: one AQN scan and eleven Guardian route scans;
- all eleven Guardian routes have completed successfully in real operation after the Environment/Technology canonical-fetch correction;
- Guardian author-profile routes preserve the configured Gary Fuller auto-approval and Damian Carrington/Fiona Harvey Pending behaviour;
- Guardian Air Pollution items enter the normal Guardian path while overlapping sightings update the existing canonical article rather than create duplicate identities;
- broader Guardian Environment, Pollution, UK, World, Climate Crisis, Science and Technology feeds reach deterministic AQ relevance filtering and discard unrelated feed entries rather than placing the whole feed in Pending;
- real Guardian rediscovery filled previously absent RSS-supplied preview images and the public image-delivery path rendered them on TEST AQ in the News cards;
- Guardian article-body/head fetching and AI remain disabled;
- repeated real central-scheduler dispatches at a temporary `*/5 * * * *` validation cadence succeeded before the scheduler job was changed to the steady-state `0 */2 * * *` cadence.

A Cloudflare Workers runtime compatibility issue discovered during early validation required RSS requests to use Fetch API `redirect: 'manual'` rather than unsupported `redirect: 'error'`. Redirect handling remains fail-closed. Guardian Environment and Technology use known canonical Guardian `/uk/.../rss` fetch targets under the narrower Guardian RSS preview contract rather than loosening generic redirect acceptance.

Native Cron dispatch in the dedicated **UK AQ Media** Cloudflare account initially failed repeatedly, including an independent minimal same-account canary, then later began dispatching normally after a long delay. The exact Cloudflare-side cause was not established. This later recovery confirmed that the Media scheduled handler itself was not the blocker, but by then the central scheduler design had been implemented and provided better shared observability, control and watchdog coverage.

The central scheduler is therefore the intended scheduling design. After repeated successful real five-minute validation dispatches, the Media native Cron trigger was removed to prevent duplicate scheduling, and the TEST central job was changed to the normal two-hour cadence.

## 4. V1 operating-cost boundary

V1 MUST be designed to operate within Cloudflare Free allowances with a target recurring infrastructure/API cost of £0.

It MUST NOT automatically enable a paid AI/API or other chargeable fallback when a free allowance is exhausted.

A free-limit failure MUST degrade by delaying discovery/enrichment or dashboard freshness while preserving already-approved public content where the underlying D1/public path remains available.

## 5. Runtime responsibility separation

The implementation MUST maintain three distinct capability boundaries, whether packaged as separate Worker deployments or equivalent explicitly separated entry points:

### `media-public`

- public;
- read-only;
- exposes approved public article data only;
- performs no discovery, AI or editorial mutation;
- uses bounded/indexed D1 reads and appropriate cache behaviour.

### `media-admin`

- authenticated;
- owns editorial mutations and source configuration changes;
- exposes authenticated mirror/sync reads for the Pro;
- MUST NOT expose internal review/rejected data through public routes.

Editorial administration and Pro mirror access SHOULD use separate credentials/secrets.

### `media-discovery`

- scheduled/backend capability;
- owns source checks, canonical identity, duplicate protection, source-policy enforcement and permitted enrichment;
- MAY expose a narrowly authenticated scheduler receiver solely to initiate its own bounded Queue work;
- MUST NOT allow the scheduler request body, query string or caller to select arbitrary sources/message types or inject arbitrary Queue work;
- MUST use a dedicated scheduling secret separate from Media admin credentials and other shared UK AQ secrets;
- is not a public editorial API.

## 6. Discovery work-unit boundary

V1 discovery SHOULD use Cloudflare Queues so the scheduling trigger remains small and individual source/article work is processed as bounded queue work rather than one large ordinary Worker invocation.

The intended current scheduling flow is:

```text
TEST central scheduler during standalone operation
    -> authenticated POST /scheduler/run
    -> enqueue source scan(s)
    -> source-scan consumer
    -> canonicalise/dedupe/store candidate
    -> optional enrichment message when source policy permits
```

At public/LIVE cut-over, the scheduler job moves from the TEST central scheduler to the LIVE central scheduler; the Media receiver and Queue path remain the same.

The HTTP scheduling receiver MUST NOT run source discovery inline. It MUST only enqueue work selected by Media's own scheduling helper. Authentication failure MUST occur before D1/Queue access. A disabled or absent scheduled source MAY produce a successful no-work response. D1/Queue scheduling failure MUST produce a non-2xx response so the central scheduler records dispatch failure.

There is no active native Media Cron trigger. The dormant Media `scheduled()` handler MAY remain in code and MAY continue to share the same enqueue helper, but it MUST NOT become an independent active scheduler while the central scheduler owns Media scheduling unless an explicit recovery/change decision re-enables it.

Queue failure, backlog or free-limit exhaustion MUST NOT remove or corrupt already-published article state.

The exact number of queues and exact schedule are implementation details unless later promoted into this contract.

## 7. Explicit source catalogue and editorial policy

The current Media implementation catalogue contains these thirteen explicitly configured source identities. A configured source may still be disabled or deferred at runtime. Communities Against Woodsmoke is an approved fourteenth source identity for the next direct-discovery change and is listed separately below because the documentation intentionally precedes implementation.

| Source | Publication policy | Review policy |
|---|---|---|
| Air Quality News | `auto_approve` | trusted-source exception |
| BBC News | `manual` | `standard` |
| The Guardian | `manual` | `standard` |
| Sky News | `manual` | `standard` |
| The Independent | `manual` | `standard` |
| Carbon Brief | `manual` | `standard` |
| OpenAQ | `manual` | `standard` |
| Phys.org | `manual` | `standard` |
| DSAWSP | `manual` | `standard` |
| The Times | `manual` | `enhanced` |
| The Telegraph | `manual` | `enhanced` |
| Daily Mail | `manual` | `enhanced` |
| The Sun | `manual` | `enhanced` |

Defra / UK-AIR has been retired from the current source catalogue and MUST NOT be reintroduced merely as part of the Communities Against Woodsmoke change.

The approved Communities Against Woodsmoke addition is:

| Source | Publication policy | Review policy | Implementation state |
|---|---|---|---|
| Communities Against Woodsmoke | `manual` | `standard` | approved next direct RSS source; not deployed until implemented and accepted |

These are explicitly configured publisher/source identities, not an exclusive list of every publisher Media may discover. Blanket UK-media discovery MAY surface additional publishers without granting them a trusted or auto-publication policy.

All Air Quality News articles are in scope and auto-approved, including international and adjacent stories. An AQN article MAY subsequently be hidden manually.

Government, university and research press releases are not auto-approved. When relevant they enter Pending review. University/research material is a discovery class rather than requiring every institution to occupy an explicitly configured source identity.

Review level indicates the amount of editorial scrutiny, not a permanent judgement that a publisher is “good”, “bad”, “trusted” or “untrusted”.

An article MAY be approved even if it criticises air-quality regulation, a Clean Air Zone, ULEZ, wood-burning restrictions or another policy position. Publication depends on relevance and material factual accuracy rather than agreement with UK AQ.

Material misinformation is valid grounds for rejection. A negative or sceptical position by itself is not.

### Communities Against Woodsmoke approved direct RSS addition

Communities Against Woodsmoke is a specialist publisher/campaign organisation whose selected direct-discovery scope is its own blog stream. The implementation MUST use the following source identity and policy unless a later explicit contract changes it:

```text
source_key: communities-against-woodsmoke
name: Communities Against Woodsmoke
canonical_domain: communitiesagainstwoodsmoke.com
source_type: publisher
publication_policy: manual
review_level: standard
discovery_method: rss
content_fetch_policy: discovery_metadata_only
ai_content_policy: metadata_only
image_policy: remote_preview
```

The direct discovery route MUST be the first-party WordPress feed:

```text
route_key: communities-against-woodsmoke-feed
url: https://www.communitiesagainstwoodsmoke.com/feed/
max_items: 20
retain_excerpt: false
```

This route is deliberately a **blog-post discovery boundary**, not permission to crawl the Communities Against Woodsmoke website. The direct adapter MUST:

1. consider only entries directly enumerated by that configured RSS feed;
2. accept only canonical article URLs on the configured Communities Against Woodsmoke publisher domain/subdomains;
3. not crawl or enumerate the site's ordinary Home, Health, Climate, Action, Contact or other static/navigation pages merely because they share the same domain;
4. not use the `/blog/` HTML listing, a sitemap or arbitrary in-site links as an additional discovery route unless a later explicit contract authorises that change;
5. not retain RSS excerpts or `content:encoded` article-body material;
6. treat the explicitly selected specialist blog feed as in scope for discovery without requiring the generic broad-publisher AQ keyword gate, while preserving manual editorial review;
7. place otherwise-new eligible feed discoveries in Pending under `manual` / `standard`, with no trusted-source auto-approval provenance;
8. preserve canonical deduplication, Rejected/Hidden precedence and cross-provider identity if the same article is also seen through GDELT or another route.

`image_policy='remote_preview'` authorises only the existing bounded presentation-metadata path in `media-preview-contract.md`. It does not authorise article-body retrieval, durable copying of publisher images or broader content use. With no Communities Against Woodsmoke-specific external image host contracted initially, preview URLs MUST remain within the generic publisher-domain/subdomain validation unless later real publisher metadata establishes a narrow publisher-controlled CDN exception and the contract is explicitly updated.

`ai_content_policy='metadata_only'` permits only policy-compatible metadata-level AI use, such as the existing bounded display-title path when otherwise enabled. It MUST NOT be interpreted as permission to send article-body content to AI.

The normal two-hour Media scheduler MAY enqueue this route only after the source exists in authoritative configuration and the Media discovery Worker's internal scheduled-source allowlist explicitly includes it. Merely inserting a D1/source row MUST NOT make an unsupported adapter schedulable.

### 7.1 V1 discovery topic families

Non-AQN discovery MUST explicitly recognise these first-class UK-media topic families:

- `uk-media-wood-burning`;
- `uk-media-wildfire`;
- `uk-media-air-pollution`;
- `uk-media-air-quality`.

This requirement exists because materially relevant coverage may not use one consistent phrase in the headline or feed metadata.

The wood-burning family SHOULD recognise strong terms and phrases such as `wood burning`, `wood-burning`, `wood burner`, `wood burners`, `log burner`, `log burners`, `wood-burning stove`, `wood burning stove`, `wood stove` and `domestic wood burning`. It SHOULD also support context-sensitive matching for terms including `domestic combustion`, `solid fuel`, `Smoke Control Area`, `Clean Air Act`, `Ecodesign`, `Defra-exempt stove`, `Ready to Burn`, `HETAS`, `Stove Industry Association` and relevant manufacturer/industry names such as `Charnwood`.

The wildfire family SHOULD recognise strong terms and phrases such as `wildfire`, `wildfires`, `wildfire smoke` and equivalent UK landscape-fire wording. Context-sensitive matching SHOULD also cover terms such as `moorland fire`, `forest fire`, `grass fire`, `vegetation fire` and `prescribed burn` where the available metadata establishes an air-quality, smoke, health or pollution connection.

The air-pollution and air-quality families SHOULD explicitly search for the phrases `air pollution` and `air quality` rather than relying on them being incidental terms within a publisher feed.

Weak generic terms such as `smoke`, `fire`, `stove` or `biomass` MUST NOT by themselves be sufficient to make an article relevant, because they would create large numbers of unrelated matches.

For non-AQN sources, a deterministic topic match is a **discovery/relevance signal only**. It MUST NOT bypass the applicable `manual` publication policy or Standard/Enhanced review level. A narrower direct-source contract MAY establish that an explicitly selected specialist feed is already in scope for discovery, as the Communities Against Woodsmoke blog feed does above, without changing its manual publication policy.

The exact phrase lists, normalisation, aliases and contextual matching implementation MAY be refined from real operational evidence without changing this contract, provided all four topic families remain covered.

AQN remains deliberately different: every AQN feed item is already in scope and auto-approved, so AQN items do not require a separate keyword/relevance gate.

### 7.2 Blanket UK-media discovery through GDELT

The current narrow GDELT transport and promotion authority is `media-gdelt-web-ngrams-contract.md`. Where older wording in this broad contract refers to the DOC 2.0 query API, the Web NGrams contract supersedes it.

V1 SHOULD use GDELT as a blanket UK-media discovery provider alongside direct publisher feeds/sitemaps, subject to the narrower Web NGrams contract.

The original DOC 2.0 query-family intent was:

```text
uk-media-wood-burning
  ("wood burning" OR "wood-burning" OR "wood burner" OR "wood burners" OR
   "log burner" OR "log burners" OR "wood burning stove" OR
   "wood-burning stove" OR "wood stove" OR "domestic wood burning")
  sourcecountry:UK sourcelang:english

uk-media-wildfire
  ("wildfire" OR "wildfires" OR "wildfire smoke" OR "moorland fire" OR
   "forest fire" OR "grass fire" OR "vegetation fire")
  sourcecountry:UK sourcelang:english

uk-media-air-pollution
  ("air pollution" OR "air-pollution")
  sourcecountry:UK sourcelang:english

uk-media-air-quality
  ("air quality" OR "air-quality")
  sourcecountry:UK sourcelang:english
```

These phrases remain topic-family intent, but transport, scope classification, candidate retention and promotion MUST follow `media-gdelt-web-ngrams-contract.md` rather than this historical query-API shape.

GDELT is a **discovery provider**, not the article publisher and not an editorial trust source. The implementation MUST keep discovery-provider/query-family provenance conceptually separate from publisher identity.

If a GDELT result belongs to one of the explicitly configured publisher domains, that publisher's configured publication/review policy applies.

If a GDELT result belongs to another UK publisher for which no explicit source policy exists, the initial default MUST be conservative:

- publication policy `manual`;
- review level `enhanced`;
- discovery metadata only;
- article-body fetching disabled;
- AI content use disabled;
- no automatic publication.

A later explicit source policy MAY relax those defaults where justified.

Direct publisher feeds remain preferred sources of publisher-native metadata where available. GDELT complements them by broadening discovery across regional, local and otherwise unconfigured UK outlets.

GDELT failure, throttling or temporary unavailability MUST NOT affect already-stored or already-approved Media content and MUST NOT block direct publisher discovery.

## 8. Article editorial state

Article status MUST support:

- `pending`
- `approved`
- `rejected`
- `hidden`

Meanings:

- `pending`: discovered and awaiting editorial decision;
- `approved`: eligible for the public Media API;
- `rejected`: reviewed and not suitable for publication;
- `hidden`: previously approved/published but removed from the public feed.

Known rejected or hidden article identities MUST NOT be recreated as fresh candidates simply because discovery encounters the URL again.

Review level is separate from status and MUST support:

- `standard`
- `enhanced`

Publication policy is source configuration and MUST support at least:

- `manual`
- `auto_approve`

## 9. Discovery, content fetching and AI are separate permissions

A source being discoverable MUST NOT be interpreted as permission to fetch/reuse its article body or submit its content to an AI service.

Source configuration MUST express separate policies for:

- discovery method/configuration;
- source-content fetching;
- AI content use;
- image-preview use.

The implementation MUST be able to represent at least these semantic states:

```text
content_fetch_policy:
  discovery_metadata_only
  article_head_allowed
  article_body_allowed

ai_content_policy:
  disabled
  metadata_only
  article_body_allowed
```

Rules:

1. Discovery permission does not imply article-body access permission.
2. Article-body access permission does not imply AI/text-mining permission.
3. Source policy MUST be checked before content is submitted to Workers AI or another model provider.
4. When AI is disabled for a source, deterministic title/URL/category filtering and human review remain valid.
5. AI enrichment MUST NOT be a prerequisite for an article to exist in the editorial queue.
6. AI enrichment MUST NOT be a prerequisite for AQN auto-approval.
7. A public approved card MAY omit a generated summary and show headline, publisher, date and original link, with optional human-written UK AQ context.
8. UK AQ-generated editorial summaries and `why_it_matters` fields MUST be distinguishable from the publisher's original content.
9. Discovery through GDELT MUST NOT be interpreted as permission to fetch the publisher article body or submit publisher content to AI.

For V1, current publisher restrictions require a conservative no-article-body-AI posture for sources where permission is not established. OGL-covered Defra/UK-AIR information MAY receive richer processing subject to OGL attribution and stated third-party-right exceptions.

Except where a source-specific route is explicitly contracted, the exact direct-publisher feed/sitemap URLs are implementation configuration rather than broad-contract constants. The Communities Against Woodsmoke main WordPress feed is explicitly contracted above because the feed itself defines the agreed blog-only discovery boundary.

## 10. AI behaviour

Workers AI is the intended V1 provider where source policy permits AI use.

The model/provider MUST be replaceable without changing article identity, status or public schema.

AI output is advisory and MUST NOT automatically approve a source configured for manual review.

AI errors, JSON/structured-output failures, capacity errors or free-limit exhaustion MUST leave the article usable for human review and MUST NOT cause candidate loss.

The implementation MUST retain sufficient AI provenance to identify the provider/model/version and enrichment time for generated fields.

A conservative local AI usage guard MUST supplement Cloudflare's own Free-plan limit and MUST NOT enable billable inference automatically.

## 11. Article identity, provider provenance and duplicate protection

The implementation MUST maintain a stable canonical article identity derived from canonical URL/normalised source identity.

Canonical identity is global across discovery providers. A direct publisher feed, GDELT query and any later discovery route MUST converge on the same article identity when they point to the same canonical article URL.

V1 MUST:

- canonicalise URLs before identity lookup/insert;
- use the existing canonical URL hash as the duplicate-prevention key across all discovery routes;
- prevent exact duplicate candidate creation;
- preserve rejected/hidden identity against rediscovery;
- allow genuinely different reporting of the same event to remain separate;
- retain enough discovery provenance to know that an article was seen via GDELT, a direct source feed or both, and which blanket query family matched.

When GDELT and a direct publisher route discover the same canonical URL:

1. only one `media_articles` identity may exist;
2. the second discovery MUST update observation/provenance evidence rather than create another article;
3. it MUST NOT reset editorial status, approval/rejection/hide timestamps or revision semantics;
4. it MUST NOT create a second auto-approval/editorial transition for an already-known article;
5. direct publisher metadata SHOULD take precedence for publisher-native fields when both routes supply conflicting values;
6. GDELT-specific discovery/provider data MUST NOT overwrite the actual publisher identity;
7. if GDELT discovers the article first and the direct publisher feed sees it later, the later direct observation MAY improve publisher-native metadata while preserving the existing article identity and editorial state.

Tracking parameters and equivalent non-identity URL noise MUST be normalised consistently before the canonical hash is calculated. Query-specific discovery provenance MUST NOT be encoded into canonical identity.

Near-duplicate/syndication grouping and a future story identity MAY be added without changing these rules. Different canonical URLs remain separate articles in V1 even when they report the same underlying event.

## 12. Public content boundary

The public Media API MUST expose only public/approved fields.

It MUST NOT expose:

- pending/rejected records;
- internal review notes;
- source-policy internals not intended for visitors;
- authentication/secrets;
- Pro mirror state.

The future website consumes only `media-public`; it MUST NOT receive D1 credentials or call editorial mutation routes.

Public feed responses SHOULD be cached because Media freshness does not require second-by-second publication.

The public website MUST degrade gracefully if Media is unavailable.

## 13. Open Graph/social-preview images

The implementation MAY collect `og:image` or equivalent social-preview metadata where permitted by the source access policy.

A publisher-hosted social-preview image MAY be rendered remotely on the preview card for the same original article unless that source/article is blocked. A narrower source-specific contract MAY explicitly permit named publisher-controlled image infrastructure, as the Guardian RSS preview contract currently does.

V1 rules:

1. use only a publisher/source preview image associated with that article;
2. render the publisher-hosted URL remotely by default;
3. do not download, copy, resize, transform or store it locally by default;
4. use it only on the corresponding article preview;
5. pair it with clear publisher/source attribution and the original headline;
6. link the preview/card to the original article;
7. do not use one article's preview image for another article or as unrelated decoration;
8. do not bypass authentication, paywalls, hotlink restrictions or other access controls;
9. allow source/article blocking and prompt removal after a publisher/rightsholder objection;
10. fall back to UK AQ artwork or a text-only card when unavailable or blocked.

Image policy MUST support at least:

- `remote_preview`
- `blocked`
- `local_copy_permitted`

`local_copy_permitted` requires an explicit permission/licence or another clearly documented right for the separate act of copying/storing the image.

The existence of an `og:image` tag or RSS image element MUST NOT be treated as a general licence to copy or durably store the image. Transient cached delivery under a narrower preview contract remains distinct from durable copying.

## 14. Dev dashboard and Pro mirror

The future dev dashboard will include a **Media** page for editorial review and operational visibility.

It SHOULD support:

- Pending/Approved/Rejected/Hidden counts;
- Standard and Enhanced Pending queues;
- source health;
- article filtering;
- original-source link;
- approve/reject/hide/unhide;
- editing UK AQ summary/`why_it_matters` and structured tags;
- featured state.

Dashboard reads MAY later use the Pro MySQL mirror for speed/history. Any action that changes authoritative Media state MUST still go through `media-admin` to D1.

## 15. Validation and public cut-over

Before implementation, validation is limited to structural viability and any targeted source access/permission check genuinely required for the chosen adapter. Broad speculative pre-implementation test suites are not required.

For Communities Against Woodsmoke, the required pre-implementation check is structural only: confirm that the generic publisher RSS route shape can represent the configured first-party `/feed/` endpoint, that the source policy can express the blog-only direct-discovery boundary above, and that no new article-body, AI or image-host permission is required. Do not create a speculative source-specific functional test suite before deployment.

After deployment, functional validation MUST use real Media operation before public website integration, including evidence that:

- AQN discovery/deduplication and auto-approval work;
- the central scheduler can authenticate to `POST /scheduler/run`, enqueue the bounded Media work units and record failure when the receiver returns non-2xx;
- Guardian author/direct/broader filtered RSS routes operate with their contracted publication/relevance behaviour;
- Guardian Environment/Technology canonical fetch targets avoid the observed redirect failure without relaxing generic redirect controls;
- Guardian RSS remote-preview images obey the source-specific image contract and render through the public image-delivery path;
- Communities Against Woodsmoke scheduled discovery consumes only its configured RSS feed, discovers feed-listed blog posts such as the then-current newest entries without crawling ordinary site pages, and leaves otherwise-new discoveries Pending under `manual` / `standard`;
- Communities Against Woodsmoke discovery does not retain article-body or feed-body content, does not auto-approve, and uses only the generic bounded `remote_preview` metadata/image path unless a later explicit image-host exception is contracted;
- manual sources remain Pending except for explicit narrower author/source publication exceptions;
- GDELT blanket discovery returns relevant UK-source results without bypassing publisher/source policy;
- GDELT/direct-feed overlap produces one canonical article identity rather than duplicate rows;
- source content/AI policies are enforced;
- AI failure does not lose candidates;
- queue failure/backlog does not damage published state;
- D1 remains authoritative;
- Pro/MySQL outage has no effect on production Media;
- rejected/hidden articles are not recreated;
- public API exposes only approved content;
- Media failure does not break normal UK AQ;
- remote preview images obey the image contracts.

Public **AQ in the News** website integration is a later explicit cut-over after that operational evidence is satisfactory.
