# UK AQ Media Communities Against Woodsmoke publisher-index contract

**Status:** Approved implementation authority for the next Communities Against Woodsmoke direct-discovery addition. This contract is source-specific and supersedes any older Communities Against Woodsmoke wording in `media_contract.md`, `README.md` or plans that refers to WordPress RSS `/feed/` discovery.

## 1. Decision and evidence

Communities Against Woodsmoke (CAWS) is to be added as a bounded direct publisher source using its public Blog index, not its WordPress RSS feed.

The previously proposed endpoint:

```text
https://www.communitiesagainstwoodsmoke.com/feed/
```

is not an approved Media discovery route. On 17 September 2026 it returned HTTP 403 in an external developer check and could not be retrieved from Codex Cloud. The Cloud failure occurred at its outbound proxy, so this contract does not claim a single origin-side cause for every 403. The practical decision is simply that Media MUST NOT depend on `/feed/`.

The public Blog page is the approved source boundary:

```text
https://www.communitiesagainstwoodsmoke.com/blog/
```

A current external check of that page showed a distinct Blog section headed **Blog**, the text **Check out the latest blog articles below**, individual article-title links with publication dates, and a later **Other groups campaigning against woodsmoke pollution** section. The page also contains ordinary site navigation such as Home, Health, Climate, Action and Contact. Therefore the adapter MUST scope extraction to the article-listing region and MUST NOT treat all same-domain links as article candidates.

This is a structural source check sufficient to approve implementation. Functional acceptance remains a post-deployment real-operation task.

## 2. Source identity and policy

The source MUST use:

```text
source_key: communities-against-woodsmoke
name: Communities Against Woodsmoke
canonical_domain: communitiesagainstwoodsmoke.com
source_type: publisher
publication_policy: manual
review_level: standard
priority: 50
discovery_method: sitemap
content_fetch_policy: discovery_metadata_only
ai_content_policy: metadata_only
image_policy: remote_preview
```

`discovery_method: sitemap` deliberately reuses the existing configuration value already used by the bounded DSAWSP first-party publisher-index adapter. It does not mean CAWS discovery may fetch a sitemap. The only approved CAWS direct-discovery URL is the Blog index below.

The source MUST be enabled when the implementation is deployed.

## 3. Bounded Blog index route

The configured route MUST be:

```text
route_key: communities-against-woodsmoke-blog-index
url: https://www.communitiesagainstwoodsmoke.com/blog/
max_items: 20
retain_excerpt: false
```

The adapter MUST fetch only that configured first-party Blog index for direct discovery. V1 CAWS discovery has no pagination route. If the publisher later introduces pagination that materially affects coverage, that requires a later explicit change based on real operation rather than speculative crawling now.

The fetch MUST follow the existing bounded publisher-index safety pattern used for DSAWSP where applicable:

- HTTPS only;
- configured publisher-domain validation;
- manual redirect handling with only same-publisher permitted destinations;
- bounded redirect count;
- HTML/XHTML content type only;
- bounded response bytes;
- bounded timeout;
- fail closed on malformed, oversized, non-HTML or disallowed redirect responses.

Implementation MAY reuse or extract existing small bounded-HTML helpers when that reduces duplication without broad unrelated refactoring. A source-specific CAWS adapter parallel to DSAWSP is also acceptable.

## 4. Article-listing extraction boundary

The Blog page contains both article links and ordinary navigation/footer links. Therefore **same-domain URL alone is insufficient** to establish a CAWS article candidate.

The parser MUST scope candidates to the Blog article-listing region that begins with the publisher's Blog/latest-articles content and ends before the later **Other groups campaigning against woodsmoke pollution** section/footer material.

Within that bounded article-listing region, an article candidate MUST have all of the following:

1. a publisher article-title link;
2. a canonical HTTPS URL permitted by the configured CAWS publisher domain;
3. a non-empty title derived from the publisher's listing;
4. a parseable publisher publication date associated with that listing/card.

The implementation SHOULD prefer semantic structure already present in the publisher HTML, such as an article/title heading and its nearby date, rather than relying only on a fragile global CSS class name. It MAY use stable source-specific markup where inspection of the current HTML shows that to be the clearest bounded approach.

The adapter MUST NOT create candidates from:

- Home;
- Health;
- Climate;
- Action or Action subpages;
- Contact;
- the `/blog/` index URL itself;
- Privacy Policy;
- Nettl/site-credit links;
- the later other-groups/footer section;
- arbitrary same-domain links elsewhere in the document;
- a sitemap;
- `/feed/`;
- links discovered by recursively following article pages.

The adapter MUST NOT crawl the site. It fetches one bounded publisher index and emits at most the configured `max_items` article candidates from that index.

## 5. Inclusion and editorial behaviour

The CAWS Blog index is a deliberately selected specialist woodsmoke publication stream. **Index membership is the direct-source relevance boundary.**

The generic broad-publisher AQ keyword/relevance filter MUST NOT be applied to otherwise-valid CAWS Blog-index candidates. This exception is source-specific and MUST NOT weaken or bypass relevance filtering for BBC News, Sky News, The Independent, Carbon Brief, OpenAQ, Phys.org, GDELT-derived unknown publishers or any other source.

Every otherwise-valid new CAWS Blog-index article therefore enters normal Media editorial state. Because the source is `manual` / `standard`, a new article MUST enter **Pending**, not Approved, unless a later explicit source/author publication-policy change applies.

CAWS MUST NOT receive `trusted_source_auto` provenance merely because the whole specialist Blog index is considered in scope for discovery.

Rejected and Hidden precedence, canonical URL deduplication and normal rediscovery semantics remain unchanged.

## 6. Metadata and content boundary

The index adapter MAY retain only the publisher metadata required for normal Media discovery, including:

- canonical article URL;
- article title;
- publisher publication date;
- source/route discovery provenance.

It MUST NOT retain page-body prose, article-body text, arbitrary Blog-index prose, excerpts or other content merely because that text is present in the HTML.

The adapter MUST NOT fetch article bodies to establish inclusion.

`content_fetch_policy=discovery_metadata_only` remains authoritative for broader content use.

`ai_content_policy=metadata_only` permits only policy-compatible metadata-level AI behaviour under the separate AI contracts. It MUST NOT be interpreted as permission to submit CAWS article-body content to AI. Routine discovery MUST not broaden the existing automatic AI source allowlist merely because CAWS is added.

## 7. Preview-image behaviour

`image_policy=remote_preview` authorises the existing generic bounded publisher presentation-metadata path in `media-preview-contract.md` after a CAWS article has been accepted by the direct-source inclusion boundary.

The CAWS publisher-index adapter does not need to scrape or copy article-body images from the Blog listing.

No CAWS-specific external image/CDN hostname is authorised by this contract. Preview URLs MUST satisfy the existing generic publisher-domain/subdomain rules unless later real publisher metadata demonstrates a legitimate external publisher-controlled host and an explicit narrow contract change approves it.

Publisher image bytes MUST NOT be durably copied under `remote_preview`.

## 8. Identity, provenance and GDELT overlap

Normal global Media canonical identity remains authoritative.

If CAWS direct discovery and GDELT discover the same canonical article URL:

- only one `media_articles` identity may exist;
- direct publisher metadata SHOULD take precedence for publisher-native title/date fields where valid;
- provider evidence MUST record the direct publisher-index observation separately from GDELT evidence;
- rediscovery MUST NOT reset Pending, Approved, Rejected or Hidden state;
- rediscovery MUST NOT create a duplicate publication transition.

The direct CAWS provider evidence SHOULD use the existing `publisher_web_index` provider class used by DSAWSP unless the implementation already has an equivalently narrow generic publisher-index provenance value.

## 9. Scheduling boundary

The normal two-hour Media direct-discovery scheduler MAY enqueue CAWS only after:

1. the source exists in authoritative configuration/D1;
2. the configuration exactly matches the supported CAWS publisher-index shape; and
3. the Media discovery Worker's internal scheduled-source allowlist explicitly includes CAWS.

Merely inserting/enabling a D1 source row MUST NOT make an unsupported source schedulable.

The scheduler request body/query string MUST NOT select CAWS or arbitrary work. CAWS remains part of Media's internally selected bounded work list.

The scheduled work unit is one `source_scan` for:

```text
source_key: communities-against-woodsmoke
route_key: communities-against-woodsmoke-blog-index
```

## 10. Structural implementation boundary

Before implementation, only structural viability is required. The following has been established:

- the public `/blog/` index exposes article titles and dates within a distinct Blog article-listing section;
- ordinary site navigation is also present, so extraction must be scoped rather than domain-wide;
- the existing source schema can represent the adapter using the same `sitemap` discovery-method value used by DSAWSP;
- the existing scheduled-source allowlist can add one explicit CAWS work unit;
- the existing `publisher_web_index` provenance class and canonical article persistence model can be reused;
- the existing generic `remote_preview` path can supply optional article preview metadata without broadening article-body permissions.

No further live pre-implementation request from Codex Cloud is required. In particular, Codex MUST NOT treat its inability to access the publisher from its cloud environment as a reason to stop implementation. It should implement to this contract and leave functional validation to deployed real operation.

Do not create speculative pre-deployment functional test suites. Existing structural/unit checks around parser/configuration logic MAY be updated where the repository's current check suite requires them.

## 11. Post-deployment real-operation acceptance

After deployment, real Media operation MUST confirm:

- the normal scheduler queues exactly one CAWS Blog-index work unit when the supported source is enabled;
- the deployed Worker can fetch the real `/blog/` page successfully from Cloudflare;
- the run records the expected CAWS route and succeeds;
- current article cards from the Blog listing are discovered;
- navigation, footer, other-groups and ordinary CAWS pages are not discovered;
- up to 20 newest valid index candidates are processed in publisher order;
- new otherwise-valid CAWS articles enter Pending under `manual` / `standard`;
- no generic broad-publisher keyword filter removes a valid CAWS Blog-index item;
- no CAWS item is auto-approved solely because it was found on the specialist Blog index;
- index/body prose is not retained;
- optional preview metadata uses only the existing bounded `remote_preview` path;
- repeated scans do not duplicate article identities or reset editorial state;
- a CAWS/GDELT overlap converges on one canonical `media_articles` row with separate provenance evidence;
- failures fetching/parsing CAWS do not affect other Media sources or already-approved content.

If the deployed Cloudflare Worker itself receives 403 or otherwise cannot fetch `/blog/`, record that as real operational evidence and revise the source strategy explicitly rather than adding an uncontracted crawl, alternate endpoint or access-control workaround.