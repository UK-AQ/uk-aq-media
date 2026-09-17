# UK AQ Media Communities Against Woodsmoke publisher-index contract

**Status:** Current source-specific implementation authority for Communities Against Woodsmoke direct discovery and preview-image handling. This contract supersedes any older Communities Against Woodsmoke wording in `media_contract.md`, `README.md` or plans that refers to WordPress RSS `/feed/` discovery or that prohibits the narrowly bounded CAWS image and source-placeholder fallbacks defined below.

## 1. Decision and evidence

Communities Against Woodsmoke (CAWS) is a bounded direct publisher source using its public Blog index, not its WordPress RSS feed.

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

Real TEST operation on 17 September 2026 confirmed that the deployed CAWS source can discover the Blog-index articles. The initial discovery also established a preview-specific limitation: CAWS article rows received `preview_metadata_checked_at` values while `og_image_url` remained null, so the existing article-head preview path completed without finding a permitted `og:image` or `twitter:image`. A current browser retrieval of a CAWS article showed that the article itself can contain a normal publisher-hosted content image under the CAWS domain, including `/wp-content/uploads/` media. The narrow source-specific fallback in section 7 is therefore approved so that CAWS can supply a useful preview image without broadening generic article-body permissions.

Subsequent real TEST use confirmed that the CAWS article-image fallback can populate genuine publisher-hosted article images where present, while some older CAWS articles have no usable publisher image. For those genuinely image-less articles, a UK AQ-owned CAWS default presentation image is approved as the final source-specific public-display fallback under section 7.3. This placeholder is not publisher metadata and MUST remain distinct from `og_image_url`.

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

The source MUST remain enabled while this adapter is operational.

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

After an article has already passed the CAWS direct-source inclusion boundary, the preview-image logic MAY inspect a tightly bounded portion of that article's HTML solely to locate a permitted presentation-image URL under section 7. This is a source-specific image-metadata exception, not permission to retain, analyse, summarise or send article-body prose to AI.

Only the selected preview-image URL and normal preview-check timestamp may be retained from this fallback. The HTML/body content used to locate it MUST remain transient and MUST NOT be stored in D1, R2, logs, discovery evidence or AI context.

`content_fetch_policy=discovery_metadata_only` remains authoritative for broader content use.

`ai_content_policy=metadata_only` permits only policy-compatible metadata-level AI behaviour under the separate AI contracts. It MUST NOT be interpreted as permission to submit CAWS article-body content to AI. Routine discovery MUST not broaden the existing automatic AI source allowlist merely because CAWS is added.

## 7. Preview-image behaviour

`image_policy=remote_preview` authorises the existing generic bounded publisher presentation-metadata path in `media-preview-contract.md` after a CAWS article has been accepted by the direct-source inclusion boundary.

The normal candidate order is:

1. permitted `og:image` from the bounded article-head metadata path;
2. permitted `twitter:image` from the bounded article-head metadata path;
3. only when neither produces a permitted preview, the CAWS-specific bounded article-image fallback defined below;
4. only when no permitted publisher image exists after those steps, the UK AQ-hosted CAWS default presentation image defined in section 7.3.

A genuine publisher-derived image always takes precedence over the default presentation image. The CAWS publisher-index page itself MUST NOT be used as an image source for individual articles.

### 7.1 CAWS-only bounded article-image fallback

The fallback is permitted only for:

```text
source_key: communities-against-woodsmoke
image_policy: remote_preview
```

and only after the article has already been accepted from the contracted Blog index. It MUST NOT become a generic fallback for other publishers.

The fallback MAY make at most one additional bounded HTML request to the accepted canonical CAWS article URL when the normal head path found no permitted preview image. That request MUST:

- use HTTPS only;
- validate the configured CAWS publisher domain before the request and after every redirect;
- use manual redirect handling with a small bounded redirect count;
- accept only HTML/XHTML;
- use a bounded timeout no greater than 15 seconds;
- inspect no more than 512 KiB of response bytes;
- stop reading as soon as a permitted article-content image has been identified;
- fail closed on disallowed redirects, malformed URLs, non-HTML responses, timeouts or byte-limit exhaustion.

The fallback SHOULD first use stable structured/presentation markup if CAWS exposes it, such as a publisher-provided JSON-LD `image` or `thumbnailUrl`. If no such usable value exists, it MAY select the first suitable image from the semantic article-content region.

A body-image candidate MUST NOT be selected merely because it is the first `<img>` in the document. Extraction MUST be scoped to the article's main/content region using stable CAWS-specific semantic structure. Header/navigation/footer images, site logos, cookie/UI images, social icons, sidebars, related-content cards, tracking pixels and other non-article images MUST be excluded.

Every fallback candidate MUST pass the existing `remotePreviewUrl` publisher-host validation. For the initial CAWS implementation, no external image/CDN hostname is authorised. A same-domain CAWS media URL such as `/wp-content/uploads/...` is permitted by the existing publisher-domain rule; an external host requires a later explicit contract amendment based on observed evidence.

The fallback MUST NOT download or retain the image bytes during discovery. It records only the permitted remote image URL; the normal remote-preview image path remains responsible for any later bounded image-byte fetch used by the product UI.

If no permitted fallback image is found, `og_image_url` may remain null. Absence of an image MUST NOT fail otherwise-valid CAWS article discovery.

### 7.2 Existing CAWS rows

CAWS rows discovered before this fallback may already have `preview_metadata_checked_at` populated with `og_image_url = NULL`. The implementation MAY perform one narrowly scoped recheck of those existing CAWS remote-preview rows so they can benefit from the new fallback.

That recheck MUST be bounded to CAWS rows with no stored preview image and MUST NOT alter article status, approval provenance, title, publication date or other editorial state. It MUST NOT create an indefinite every-run retry loop for CAWS articles that genuinely have no suitable image.

A small forward-only migration or equivalently bounded versioned recheck mechanism is acceptable. If a migration is used, it SHOULD only make the existing CAWS null-image rows eligible for one subsequent preview refresh; it MUST NOT rewrite article identities or editorial fields.

Publisher image bytes MUST NOT be durably copied under `remote_preview`.

### 7.3 UK AQ-hosted CAWS default presentation image

When a CAWS article has no permitted publisher-derived image after the normal article-head lookup and the bounded CAWS article-image fallback, Media MAY expose a UK AQ-owned static CAWS default image as the final presentation fallback.

The approved repository asset is:

```text
apps/media-public/public/source-images/communities-against-woodsmoke-default.png
```

and its public path SHOULD remain:

```text
/source-images/communities-against-woodsmoke-default.png
```

unless a later implementation-level static-asset convention changes the path without changing the policy boundary.

This fallback MUST obey all of the following:

- it applies only to `source_key='communities-against-woodsmoke'`;
- it applies only when no genuine publisher image is currently stored/available for the article;
- it is a UK AQ-owned presentation asset, not publisher metadata;
- it MUST NOT be written into `media_articles.og_image_url`;
- it MUST NOT be represented as a discovered publisher image or publisher provenance;
- it MUST NOT pass through the publisher remote-preview proxy merely to make it look like an article image;
- public Media responses MAY expose the first-party static asset URL as `preview_image_url` for otherwise image-less CAWS articles;
- a later genuine publisher image MUST automatically take precedence over the default without requiring editorial replacement of the placeholder;
- no per-article durable copy of the placeholder is required or permitted merely for this fallback;
- failure to serve the placeholder MUST NOT invalidate the article or alter editorial state.

Because this is a UK AQ-owned asset rather than copied publisher media, storing the single source placeholder in the Media repository and deploying it as a `media-public` static asset is permitted. The publisher-image durability restrictions in `media-preview-contract.md` continue to apply to publisher-origin images and are not weakened by this source placeholder.

The placeholder is a presentation fallback only. `og_image_url = NULL` remains the correct durable article metadata state when the publisher supplied no usable image.

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

The following has been established structurally or through real TEST operation:

- the public `/blog/` index exposes article titles and dates within a distinct Blog article-listing section;
- ordinary site navigation is also present, so extraction must be scoped rather than domain-wide;
- the existing source schema represents the adapter using the same `sitemap` discovery-method value used by DSAWSP;
- the existing scheduled-source allowlist supports one explicit CAWS work unit;
- the existing `publisher_web_index` provenance class and canonical article persistence model are reused;
- deployed CAWS discovery has produced article rows from the Blog index;
- the existing generic article-head preview path has completed for CAWS rows while leaving their image URL null;
- the existing `remotePreviewUrl` rule already permits same-domain HTTPS CAWS image URLs, so no external-host exception is needed for the observed WordPress media pattern;
- the CAWS bounded article-image fallback has produced real publisher-hosted thumbnails where suitable article images exist;
- some older CAWS articles have no suitable publisher image and therefore need a presentation-only source placeholder rather than fabricated publisher metadata;
- `media-public` is already the authoritative service that exposes `preview_image_url`, so it is the correct ownership boundary for the static CAWS placeholder.

No live pre-implementation request from Codex Cloud is required for the static placeholder. Structural viability is limited to confirming that the existing `media-public` Worker configuration can expose a repository-owned static asset without changing publisher-image validation or D1 article metadata semantics.

Do not create a speculative pre-deployment functional test suite. Existing focused deterministic checks MAY be extended to validate the source-specific placeholder selection and precedence where the repository's current check architecture supports that cleanly.

## 11. Post-deployment real-operation acceptance

After deployment, real Media operation MUST confirm:

- the normal scheduler still queues exactly one CAWS Blog-index work unit when the supported source is enabled;
- the deployed Worker still fetches the real `/blog/` page successfully from Cloudflare;
- current Blog article cards are still discovered correctly;
- navigation, footer, other-groups and ordinary CAWS pages are not discovered;
- up to 20 newest valid index candidates are processed in publisher order;
- new otherwise-valid CAWS articles enter Pending under `manual` / `standard`;
- no generic broad-publisher keyword filter removes a valid CAWS Blog-index item;
- no CAWS item is auto-approved solely because it was found on the specialist Blog index;
- a CAWS article with a usable normal `og:image` or `twitter:image` continues to use that normal head metadata without invoking the body fallback;
- a CAWS article with no usable head image but with a suitable same-domain article-content image can populate `og_image_url` through the bounded CAWS fallback;
- the fallback selects the genuine article-content image rather than a logo, navigation/footer image, icon, related-content image or tracking asset;
- article/body prose is not retained or sent to AI;
- the fallback records only a permitted remote image URL and the normal preview-check timestamp;
- existing CAWS rows with null images receive at most the intended one-time refresh opportunity rather than an indefinite retry every two hours;
- the normal remote-preview image proxy can subsequently serve the selected same-domain image under existing rules;
- a CAWS article with no genuine publisher image may expose `/source-images/communities-against-woodsmoke-default.png` as its public `preview_image_url`;
- use of the default image leaves `media_articles.og_image_url` null and does not create publisher-image provenance;
- a genuine publisher image takes precedence over the default whenever one is present or later becomes available;
- the single UK AQ-owned default asset is served from the Media public surface without creating per-article image copies;
- repeated scans do not duplicate article identities or reset editorial state;
- a CAWS/GDELT overlap converges on one canonical `media_articles` row with separate provenance evidence;
- failures in optional CAWS image enrichment or placeholder delivery do not fail otherwise-valid CAWS article discovery or affect other Media sources.

If the deployed Cloudflare Worker itself cannot fetch an individual CAWS article for the optional image fallback, record that as preview-enrichment evidence. If no publisher image is available, the public CAWS placeholder may still be used. Do not fall back to `/feed/`, a sitemap, recursive crawling, a proxy, an external image host or another access-control workaround.