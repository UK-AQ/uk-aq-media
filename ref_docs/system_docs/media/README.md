# UK AQ Media

## Scope and status

This area defines the agreed authoritative contract for the **UK AQ Media / AQ in the News subsystem**.

The standalone Media backend was deployed on **8 September 2026** and completed real-operation validation for AQN, the initial Guardian adapter and the authenticated central-scheduler path. The implementation has since expanded to additional bounded direct publisher adapters and GDELT Web NGrams discovery. Communities Against Woodsmoke is now an approved next bounded publisher-index source addition, but this documentation intentionally precedes its Media implementation and deployment. The subsystem is deliberately **not yet connected to the public/LIVE UK AQ website**. The deployed TEST website may consume the standalone public Media feed through the contracted same-origin bridge.

The implementation repository is the private `UK-AQ/uk-aq-media` repository. Runtime implementation belongs there. Codex and other coding agents treat this `system_docs/` area as read-only.

This area also contains [`media-homepage-latest-six-contract.md`](media-homepage-latest-six-contract.md), which is explicitly **future implementation authority** for the homepage-specific generation/versioned-cache design. It is not evidence that those endpoints, D1 state or long-lived cache entries are deployed. The current public `GET /articles` runtime remains authoritative until that future contract is implemented and accepted on TEST.

This area also contains [`media_bluesky_contract.md`](media_bluesky_contract.md), which is the **current TEST authority** for article publication to the UK AQ Bluesky account `@ukaq.co.uk`. It defines automatic publication for genuinely auto-approved articles, explicit opt-in Bluesky publication whenever an operator manually chooses Approved, thumbnail-backed external cards, durable D1 publication/audit state, the dedicated Bluesky Queue, configurable cooldown, idempotency, operator cancellation and dashboard controls. Its current-status wording does not by itself imply that public Bluesky publishing is enabled or that the public/LIVE UK AQ website depends on Media.

This area also contains [`media_facebook_contract.md`](media_facebook_contract.md), the **authoritative future implementation contract** for manual-only V1 publication to the configured UK AQ Facebook Page. The provider-independent foundation and dormant admin integration exist, but Facebook remains disabled pending the server-side provider/Queue runtime and TEST operational acceptance. The contract owns Page identity, credential/data-access lifecycle, remote-dispatch ambiguity, conservative retry and reconciliation behaviour.

## Current standalone runtime

UK AQ Media uses one real service in the dedicated Cloudflare account **UK AQ Media**.

Current deployed resources are:

- D1 database `uk-aq-media`, authoritative for Media state;
- Queue `uk-aq-media-discovery`;
- Worker `uk-aq-media-public`, public read-only approved feed;
- Worker `uk-aq-media-admin`, authenticated editorial/admin API;
- Worker `uk-aq-media-discovery`, authenticated scheduler receiver and Queue consumer.

Current public Worker endpoints are:

- `https://uk-aq-media-public.uk-aq-media.workers.dev`
- `https://uk-aq-media-admin.uk-aq-media.workers.dev`

The deployed `media-discovery` Worker exposes the authenticated backend scheduling receiver at:

```text
POST https://uk-aq-media-discovery.uk-aq-media.workers.dev/scheduler/run
```

The receiver accepts only the dedicated scheduling credential header, ignores request-body work selection, and can enqueue only the bounded scheduled work selected internally by Media from currently enabled/configured sources and author rules. Missing/invalid authentication fails before D1/Queue access. Credential values MUST remain managed secrets and MUST NOT be stored in source, Wrangler vars, D1 or scheduler job configuration.

The scheduling credential is stored through the existing encrypted deployment paths in the Media and TEST ops repositories. Normal Media deployment applies it only to `uk-aq-media-discovery`; normal TEST scheduler deployment applies the same credential to the TEST central scheduler. Credential values are not committed to either repository.

The current Media implementation can schedule direct discovery for Air Quality News, The Guardian, BBC News, Sky News, The Independent, Carbon Brief, OpenAQ, Phys.org and DSAWSP when the corresponding source is enabled and structurally configured.

AQN uses `https://airqualitynews.com/feed/`, contracted source-wide auto-approval, bounded article-head preview-metadata retrieval and no AI dependency. AQN article-body/`content:encoded` material is not retained or republished by UK AQ.

The Guardian uses eleven bounded RSS route work units: three author-profile feeds, the Air Pollution feed, and seven broader section/topic feeds. Guardian discovery remains `manual` / `standard` at source level, with the explicit Gary Fuller author-auto-approval exception. Guardian uses RSS metadata only, keeps AI disabled, and may use permitted RSS-supplied preview images through `remote_preview` under the narrower Guardian RSS preview contract.

BBC News, Sky News, The Independent, Carbon Brief, OpenAQ and Phys.org use the bounded generic publisher RSS path. DSAWSP uses a bounded first-party publisher-index adapter. Their current source policies remain separate from AQN's trusted-source auto-approval exception.

### Approved next source: Communities Against Woodsmoke

Communities Against Woodsmoke is approved as the next direct publisher source but MUST NOT be described as deployed until the Media repository change is deployed and accepted through real operation.

Its contracted source policy is:

```text
source_key: communities-against-woodsmoke
canonical_domain: communitiesagainstwoodsmoke.com
publication_policy: manual
review_level: standard
discovery_method: sitemap
content_fetch_policy: discovery_metadata_only
ai_content_policy: metadata_only
image_policy: remote_preview
```

The only approved direct discovery route is its bounded public Blog index:

```text
route_key: communities-against-woodsmoke-blog-index
url: https://www.communitiesagainstwoodsmoke.com/blog/
max_items: 20
retain_excerpt: false
```

The earlier proposed WordPress `/feed/` route is not an approved Media dependency after repeated HTTP 403 results during source checking. The CAWS-specific authority is now [`media-caws-publisher-index-contract.md`](media-caws-publisher-index-contract.md), which supersedes any older CAWS RSS/feed wording in broader contracts or plans.

This is a blog-only direct-discovery boundary. The adapter may process only valid article cards from the Blog article-listing region. It MUST NOT treat the page's Home, Health, Climate, Action, Contact, Privacy, footer, other-groups or arbitrary same-domain links as articles, MUST NOT use a sitemap or `/feed/`, and MUST NOT recursively crawl article pages for discovery.

The selected CAWS Blog index is specialist woodsmoke material, so valid article-card membership establishes direct-source relevance without the generic broad-publisher AQ keyword gate. The source remains `manual` / `standard`, so otherwise-new discoveries enter Pending and are not auto-approved.

The generic `remote_preview` contract may obtain bounded publisher presentation metadata for accepted CAWS articles, but CAWS initially has no special external image-host exception. Article-body content, arbitrary Blog-index prose and durable publisher-image copies remain outside the permission boundary.

The authoritative CAWS discovery details and post-deployment validation requirements are in [`media-caws-publisher-index-contract.md`](media-caws-publisher-index-contract.md). Publication-state semantics remain governed by [`media-publication-policy-contract.md`](media-publication-policy-contract.md).

Workers AI is bound for policy-permitted enrichment. AI permissions remain source-specific and do not authorise article-body use merely because a source is discoverable.

### Non-AQN topic coverage

Non-AQN discovery MUST explicitly cover four first-class UK-media query families:

- `uk-media-wood-burning`;
- `uk-media-wildfire`;
- `uk-media-air-pollution`;
- `uk-media-air-quality`.

This matters because relevant headlines may use terms such as `wood burner`, `log burner`, `wood-burning stove`, `Smoke Control Area`, `wildfire`, `moorland fire` or `wildfire smoke`, while other relevant coverage may use the broader phrases `air pollution` or `air quality`.

Topic matching is a discovery/relevance signal only. It does not bypass the contracted manual Standard/Enhanced review policy for non-AQN sources except where a narrower source or author rule explicitly defines different inclusion behaviour. The Communities Against Woodsmoke bounded Blog index is such a narrower inclusion boundary: a valid article card in the selected article-listing region establishes direct-source inclusion, but not automatic publication.

AQN is different: all AQN feed items are already in scope and auto-approved, so an AQN wood-burning, wildfire, air-pollution or air-quality story is already discovered without a separate keyword gate.

### Current Guardian discovery and author rules

Media author-specific inclusion and publication behaviour is governed by [`media-author-rules-contract.md`](media-author-rules-contract.md). Guardian RSS fetch/image behaviour is governed by [`media-guardian-rss-preview-contract.md`](media-guardian-rss-preview-contract.md).

The current explicit Guardian author rules are:

- **Gary Fuller:** always include and auto-approve newly discovered articles;
- **Damian Carrington:** always include, but newly discovered articles remain Pending;
- **Fiona Harvey:** always include, but newly discovered articles remain Pending.

These are author-specific rules, not a source-wide change to The Guardian. Other Guardian articles continue to follow the normal Guardian manual/Standard policy.

The initial Guardian adapter currently schedules eleven overlapping RSS routes when all three author rules are enabled:

- Gary Fuller profile;
- Damian Carrington profile;
- Fiona Harvey profile;
- Guardian Air Pollution;
- Environment;
- Pollution;
- UK;
- World;
- Climate Crisis;
- Science;
- Technology.

The author-profile routes bypass the normal AQ relevance gate because their configured author rules establish inclusion. The Air Pollution route is directly in scope. The seven broader Environment/Pollution/UK/World/Climate Crisis/Science/Technology routes use the deterministic AQ relevance filter before otherwise-new articles may enter Pending.

Environment and Technology retain their publisher-facing logical RSS URLs but use the current canonical Guardian `/uk/environment/rss` and `/uk/technology/rss` targets for the actual bounded fetch, avoiding the Guardian's redirect while preserving strict generic redirect handling.

Author rules are deliberately split into inclusion and publication dimensions so a future rule can always surface an author's work without automatically publishing it. Author identity, canonical deduplication, overlap between author/topic/GDELT feeds, rejected/hidden precedence and truthful author-auto-approval provenance are owned by the author-rules contract.

### Blanket UK-media discovery through GDELT Web NGrams

The current GDELT blanket-discovery authority is [`media-gdelt-web-ngrams-contract.md`](media-gdelt-web-ngrams-contract.md). It supersedes the older DOC 2.0 query-API transport wording in the broad Media contract.

Media uses GDELT's downloadable Web NGrams + TOC file pairs as one global acquisition path. Matching candidates are classified by publisher scope, and Phase 1 promotes only relevant UK publisher candidates into normal Media editorial state. GDELT is a discovery provider, not the publisher and not an editorial trust signal.

The four provider-neutral topic families remain wood burning, wildfire, air pollution and air quality. High-recall NGram matching does not itself bypass deterministic second-stage relevance or publisher publication policy.

Direct publisher feeds and bounded publisher indexes remain valuable alongside GDELT. They provide a more authoritative route for known publishers and richer publisher-native metadata, while GDELT provides breadth across UK outlets not explicitly configured.

#### Cross-provider duplicate handling

All discovery routes MUST converge on the same canonical article identity before creating a new article.

If GDELT and a direct publisher route discover the same canonical URL:

- only one `media_articles` identity may exist;
- the existing canonical URL hash remains the duplicate-prevention key;
- rediscovery MUST NOT reset `pending`, `approved`, `rejected` or `hidden` editorial state;
- rediscovery MUST NOT create a second auto-approval/editorial transition;
- provider/query-family provenance SHOULD be retained separately from publisher identity;
- publisher-native direct metadata SHOULD take precedence over less-direct GDELT metadata when both describe the same article;
- repeated GDELT sightings MAY update first/last-seen or provenance evidence without creating a duplicate article.

If GDELT discovers an article from one of the explicitly configured publishers, that publisher's configured review/publication policy applies, subject to any explicit matching author rule in `media-author-rules-contract.md`. An article from another UK publisher discovered only through blanket search defaults to **manual Enhanced review**, metadata-only discovery, no article-body AI and no automatic publication until a source-specific policy is explicitly added.

### Operational validation status, 10 September 2026

Real operation has now validated both the AQN path and the initial Guardian adapter through the deployed Queue consumer and public Media path.

Confirmed real-operation evidence includes:

- direct publication of a `source_scan` message to `uk-aq-media-discovery` reaches the discovery consumer;
- the consumer fetches and parses the real AQN RSS feed;
- the first successful AQN scan inserted its articles and auto-approved them under `trusted_source_auto`;
- repeated AQN scans update existing observations without creating duplicate article identities;
- previously failed Queue messages can retry and subsequently succeed without duplicating stored articles;
- the public `GET /articles` endpoint exposes approved records;
- the authenticated admin API exposes authoritative D1 article and discovery-run state;
- AQN operates with AI disabled and generated summary/`why_it_matters` fields unset;
- the TEST central scheduler successfully sends authenticated requests across Cloudflare accounts;
- with AQN plus all three enabled Guardian author rules, the receiver enqueues 12 bounded Queue messages: one AQN scan plus eleven Guardian route scans;
- all eleven Guardian routes have completed successfully in real operation after the Environment/Technology canonical-fetch correction;
- the three Guardian profile feeds each process their bounded ten newest entries and preserve the contracted Gary/Damian/Fiona publication behaviour;
- the Guardian Air Pollution feed processes directly in scope while canonical overlap updates the existing article rather than duplicating it;
- the broader Guardian feeds apply deterministic filtering in real operation, including observed runs where Pollution accepted 2/10, Climate Crisis accepted 1/10, Environment accepted 1/10, and UK/World/Science/Technology filtered all 10 current entries;
- real Guardian rediscovery populated previously absent RSS-supplied preview images from the explicitly permitted `i.guim.co.uk` host;
- those Guardian images are served through the existing transient `media-public /article-images/:id` delivery path and render on the TEST AQ in the News cards;
- the Guardian image change did not require article-body/head fetching or AI.

A Cloudflare Workers compatibility issue was found during early AQN validation: Workers does not support Fetch API `redirect: 'error'`. The RSS reader therefore uses `redirect: 'manual'` and fails closed on unapproved redirects. Guardian Environment and Technology are now fetched directly at their known canonical Guardian targets rather than broadening redirect acceptance.

Native Cron dispatch in the dedicated **UK AQ Media** Cloudflare account initially failed repeatedly, including an independent minimal same-account canary, then later began dispatching normally after a long delay. The exact Cloudflare-side cause was not established. By that point the central-scheduler design had been implemented and provided better shared observability, control and watchdog coverage, so it remains the intended scheduling architecture.

The Media native Cron trigger has now been removed from Cloudflare and from `apps/media-discovery/wrangler.jsonc`, so normal Media deployment will not recreate it. The `scheduled()` handler remains in code as a dormant fallback capability.

The central scheduler has independent Cloudflare-Cron and MacBook Pro watchdog trigger paths with atomic minute-slot claiming. During standalone operation the Media job belongs to the **TEST** central scheduler. When Media moves to public/LIVE operation, the equivalent job MUST move to the **LIVE** central scheduler.

### Discovery cadence

The current normal direct publisher discovery cadence is **every two hours** (`0 */2 * * *`) in the TEST central scheduler. GDELT Web NGrams discovery has its separate cadence and execution boundary under `media-gdelt-web-ngrams-contract.md`.

The earlier temporary `*/5 * * * *` validation cadence was used only to prove repeated real cross-account dispatches. It is no longer the active Media direct-discovery cadence.

There is no native Media Cron trigger configured. The dormant `scheduled()` handler MAY remain in code, but the central scheduler is the active scheduling authority.

### Deployment automation

Relevant pushes to `main` in `UK-AQ/uk-aq-media` automatically run the repository's Media deployment workflow.

The workflow:

1. installs dependencies and runs the repository checks;
2. validates required Cloudflare configuration and scheduling credentials;
3. applies outstanding remote D1 migrations;
4. deploys `media-public`;
5. deploys `media-admin`;
6. applies the scheduling credential only to `media-discovery` through the established secret-management path;
7. deploys `media-discovery`.

Deployment authentication and admin credentials retain their established encrypted repository/deployment paths. Credential values MUST NOT be stored in repository source or Wrangler vars.

## Start here

Read [`media_contract.md`](media_contract.md) for the broad authoritative implementation/runtime contract. For Communities Against Woodsmoke specifically, [`media-caws-publisher-index-contract.md`](media-caws-publisher-index-contract.md) is the narrower and newer authority and supersedes older CAWS RSS/feed wording in the broad contract.

For Communities Against Woodsmoke's bounded `/blog/` publisher-index route, article-listing extraction boundary, source-specific relevance inclusion, scheduling shape and post-deployment acceptance, read [`media-caws-publisher-index-contract.md`](media-caws-publisher-index-contract.md).

For source-wide and author-specific publication-state semantics, including Communities Against Woodsmoke's contracted `manual` / `standard` policy, read [`media-publication-policy-contract.md`](media-publication-policy-contract.md).

For current blanket discovery through GDELT Web NGrams, read [`media-gdelt-web-ngrams-contract.md`](media-gdelt-web-ngrams-contract.md). It is the narrow authority where older broad-contract GDELT transport wording differs.

For current TEST Bluesky article publication behaviour, read [`media_bluesky_contract.md`](media_bluesky_contract.md). It is the narrow authority for automatic Bluesky jobs from genuine source/author auto-approval, explicit opt-in social publication whenever an operator manually chooses Approved, the no-thumbnail/no-post rule, bulk all-or-nothing eligibility, durable cancellation/audit state, D1 outbox/idempotency, the dedicated Bluesky Queue, oldest-first backlog ordering, configurable cooldown and the `@ukaq.co.uk` publishing account.

For the agreed manual-only Facebook V1 and its implemented dormant foundation, read [`media_facebook_contract.md`](media_facebook_contract.md). It is the narrow authority for Page identity, deterministic link posts, independent operator intent, Queue/secret boundaries, provider API behaviour, no remote idempotency primitive, ambiguous writes, stale claims, exact-ID reconciliation and operational acceptance. It does not assert that remote Facebook publishing is enabled.

For the agreed future homepage latest-six generation, D1 state, versioned feed and 24-hour Cache API behaviour, read [`media-homepage-latest-six-contract.md`](media-homepage-latest-six-contract.md). It is explicitly **future implementation authority**, not current runtime. It owns homepage-specific cache invalidation semantics and is separate from any future full News-page generation/cache design.

For author-specific discovery inclusion and publication exceptions, including the Guardian author/profile-feed rules, read [`media-author-rules-contract.md`](media-author-rules-contract.md). It is the narrower authority where an explicit author rule differs from the broad source-wide publication policy.

For article preview images, bounded article-head metadata access, transient cached remote previews and compact display-title semantics, read [`media-preview-contract.md`](media-preview-contract.md). It is the narrower authority for those concerns and supersedes the broader contract's image-preview rules where they differ.

For Guardian-specific RSS canonical fetch targets and RSS-supplied remote-preview images, read [`media-guardian-rss-preview-contract.md`](media-guardian-rss-preview-contract.md). It is the narrowest authority for those Guardian behaviours and supersedes broader image restrictions where they differ.

The contracts define the load-bearing boundaries for:

- editorial status and review policy;
- the explicitly configured publisher/source catalogue and approved Communities Against Woodsmoke addition;
- Communities Against Woodsmoke's bounded first-party `/blog/` article-listing discovery boundary, manual review and no site crawling;
- AQN auto-approval;
- author-specific always-include and publication rules;
- the eleven current Guardian RSS routes and their direct/filtered/author-specific handling;
- Guardian RSS remote-preview image use and canonical Environment/Technology fetch targets;
- blanket UK-media discovery through GDELT Web NGrams;
- the four V1 UK-media topic families for wood burning, wildfire, air pollution and air quality;
- cross-provider canonical URL deduplication and discovery provenance;
- discovery versus article-content/AI permission;
- D1 authority;
- public/admin/discovery Worker separation;
- queue-based discovery work units;
- authenticated central-scheduler to Media discovery triggering;
- the MacBook Pro/MySQL mirror boundary;
- Open Graph/social-preview metadata, cached remote preview delivery and optional compact display titles;
- future homepage latest-six generation/versioned-cache behaviour;
- current TEST event-driven Bluesky article publication, automatic-only auto-approval posting, explicit manual-approval opt-in, thumbnail-backed external cards, D1 publication history, Queue cooldown/order, cancellation and dashboard controls;
- future manual-only Facebook V1, including its implemented dormant durable/admin foundation and the required conservative remote-write boundary;
- the £0 V1 operating requirement;
- public-site independence from Media failure.

Detailed implementation sequencing, source-route research and phase history live in [`../../plans/2026-09-07 UK AQ Media/UK_AQ_Media_Plan.md`](../../plans/2026-09-07%20UK%20AQ%20Media/UK_AQ_Media_Plan.md). The plan is non-authoritative and MUST NOT override these contracts or this current-runtime summary.

The current Bluesky implementation sequence lives in [`../../plans/2026-09-11 UK AQ Media Bluesky/UK_AQ_Media_Bluesky_Plan.md`](../../plans/2026-09-11%20UK%20AQ%20Media%20Bluesky/UK_AQ_Media_Bluesky_Plan.md). It is non-authoritative and MUST follow `media_bluesky_contract.md`.

The current Facebook implementation sequence lives in [`../../plans/2026-09-19 UK AQ Media Facebook/UK_AQ_Media_Facebook_Plan.md`](../../plans/2026-09-19%20UK%20AQ%20Media%20Facebook/UK_AQ_Media_Facebook_Plan.md). It is non-authoritative and MUST follow `media_facebook_contract.md`.

## Current integration boundary

Until a later explicit public cut-over decision:

- the standalone Media service and the deployed TEST AQ in the News surface MAY be used for validation;
- no public/LIVE UK AQ path may depend on the Media service;
- the standalone Media service MUST continue to be validated independently with real content;
- the main public/LIVE UK AQ website, map, charts, ingest and other core services MUST remain independent of Media availability.
