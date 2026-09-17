# UK AQ Media preview image and display-title contract

**Status:** Current narrow implementation authority for article preview images, compact display titles, explicit publisher-metadata reload and versioned public image delivery. This contract is narrower than `media_contract.md` and supersedes that file's image-preview rules where they differ. AI-assisted display-title suggestion is governed separately by `media-display-title-ai-contract.md`.

## 1. Scope

This contract owns:

- publisher-supplied preview-image discovery for Media articles;
- bounded article-head metadata access used only for permitted presentation metadata, including narrow Bluesky external-card metadata where explicitly authorised by `media_bluesky_contract.md`;
- optional compact display titles while preserving the publisher's original headline;
- explicit authenticated reload of permitted publisher metadata for an existing article;
- transient Cloudflare edge caching of remote preview-image bytes;
- versioned public Media image-delivery URLs/cache identity used by UK AQ presentation surfaces.

It does not itself authorise article-body fetching, article-body storage, AI use, durable local copies of publisher images or LIVE public website cut-over. The separate `media-display-title-ai-contract.md` is the narrow authority for bounded Workers AI display-title suggestions and source-specific RSS metadata supplied to that feature.

The deployed TEST website MAY consume the public Media feed through the same-origin Ops cache-proxy bridge defined by `../cache_proxy/media-public-feed-contract.md`. That bridge does not move Media authority into Ops.

## 2. Original headline and compact display title

`media_articles.title` remains the publisher's original headline and MUST NOT be replaced by UK AQ compact wording.

Media MAY add an optional compact presentation field:

```text
display_title
display_title_origin
```

`display_title_origin` MUST distinguish at least:

- `publisher`
- `human`
- `ai`

Rules:

1. `display_title` is optional. Public clients MUST fall back to `title` when it is absent.
2. A publisher-origin display title MAY come from publisher-supplied metadata such as `og:title` or `twitter:title` when that metadata is genuinely distinct and more suitable for a compact card.
3. A human or AI display title MUST preserve the material factual meaning of the original headline and MUST NOT add a new claim.
4. The original publisher `title` MUST remain available in the public Media response even when a compact title is also exposed.
5. Automatic rediscovery MUST NOT overwrite an existing human or AI display title. A previously absent display title MAY be filled from later publisher metadata.
6. An explicit editorial metadata reload MUST also preserve an existing human or AI display title unless a separate explicit human edit changes it.
7. Workers AI display-title suggestions MAY be enabled only under `media-display-title-ai-contract.md`. In phase one that contract requires no automatic AI call for publisher headlines of 64 characters or fewer, requires human review before an AI suggestion becomes public, and preserves direct human display-title editing for every article.

## 3. Bounded publisher article-head metadata access

For a source whose article-level image policy is `remote_preview`, Media MAY obtain publisher-supplied presentation metadata from the canonical article page even when the broader source `content_fetch_policy` remains `discovery_metadata_only`. This is a narrow presentation-metadata capability, not article-content fetching permission.

The `remote_preview` permission therefore MAY be used by both automatic preview discovery and the authenticated editorial metadata-reload path to read only the bounded HTML `<head>` required by this contract. It MUST NOT implicitly enable article-body access, article-body storage, article-body description extraction or article-body AI use. A narrower contract MAY explicitly consume bounded publisher description metadata from the HTML `<head>` without changing that boundary. `media_bluesky_contract.md` currently does so for Bluesky external-card text.

A bounded article-head metadata fetch MUST:

1. use the canonical publisher article URL already associated with the Media article;
2. require HTTPS and the configured publisher canonical domain/subdomains;
3. use a bounded GET intended only to read the HTML `<head>`;
4. use `redirect: 'manual'` and allow only redirects whose resolved destination still passes the configured publisher-domain validation, with a conservative redirect-count limit;
5. require an HTML content type;
6. stop and cancel the response body as soon as `</head>` has been obtained;
7. fail closed at a conservative byte limit if `</head>` has not been reached;
8. use a bounded timeout;
9. extract only presentation metadata required by this contract or an active narrower contract, including `og:image`, `twitter:image`, `og:title`, `twitter:title`, `og:description`, `twitter:description`, standard `<meta name="description">` and other bounded publisher fields explicitly consumed by Media such as site name, author and publication timestamp;
10. never retain or parse article-body text, article-body descriptions or article `content:encoded` through this route; bounded description metadata contained in `<head>` MAY be parsed only where an active narrower contract explicitly consumes it;
11. never submit article-head or article-body content to AI merely because `remote_preview` is enabled.

Parsing bounded description metadata from the HTML `<head>` does not by itself create a general Media article-description field or authorise durable storage of that description. The Bluesky publisher MAY use such metadata transiently at publication time only as defined by `media_bluesky_contract.md`.

The initial implementation SHOULD use a 256 KiB maximum head-read budget and a 10-second timeout. These are implementation safety bounds and may later be tightened from real-operation evidence without changing the contract.

Feed-supplied preview-image metadata remains preferred when valid. Article-head discovery is a fallback when the feed does not provide a permitted preview image, and the same bounded implementation SHOULD be reused by the authenticated editorial metadata-reload path.

A source with `image_policy='blocked'` MUST NOT gain this capability. Changing `content_fetch_policy` remains a separate decision for broader content access and MUST NOT be inferred from this presentation-metadata exception.

## 4. Preview URL validation

A discovered preview URL MUST:

- be HTTPS;
- belong to the configured publisher domain/subdomains unless this contract or a narrower source-specific contract explicitly permits a named publisher CDN;
- originate from feed metadata or permitted article-head metadata for the same article;
- pass both source-level and article-level image policy checks before public exposure.

A preview URL is metadata only. It does not alter canonical article identity.

Automatic rediscovery MAY fill a previously null `og_image_url`, but MUST NOT overwrite an existing non-null article image selection automatically. This preserves future manual image choices and article-level blocks. Source-specific explicit repair exceptions may be defined by a narrower contract, such as the Guardian RSS preview contract.

### 4.1 BBC News image CDN

BBC News `remote_preview` images MAY use the exact publisher-operated hostname `ichef.bbci.co.uk` in addition to the configured BBC article domain.

This is a source-specific CDN exception for `source_key='bbc-news'`. It MUST NOT be implemented as a wildcard allowance for arbitrary `bbci.co.uk`, `bbc.co.uk`, `bbc.com` or other external hosts.

A BBC image on `ichef.bbci.co.uk` is permitted only when the URL is supplied as preview metadata for the same article through the configured BBC RSS metadata such as `media:thumbnail` / image `media:content`, or through the bounded article-head metadata path defined above. Media MUST use the supplied validated HTTPS image URL rather than inventing or rewriting a different BBC image path or resolution.

The same source-specific URL validator MUST govern automatic RSS preview discovery, bounded article-head metadata reload/apply and the transient public image-fetch path. A future additional BBC image hostname requires an explicit contract update based on observed publisher metadata rather than broadening the rule to a parent-domain wildcard.

BBC articles remain valid Media records when no permitted publisher image is supplied. Lack of an image MUST NOT make the article/public feed unusable.

## 5. Explicit editorial metadata reload

The authenticated Media editorial path MAY explicitly reload publisher metadata for an existing article when requested by an editor. Dashboard behaviour and URL-led article management are governed by `media-manual-add-contract.md`.

This path exists for repair and deliberate refresh, including older articles that fell outside the current discovery feed before preview metadata was obtained.

Rules:

1. Reload MUST use the same canonical article URL, source policy, publisher-domain validation, bounded article-head reader, redirect handling, content-type checks, byte limit and timeout as the normal permitted preview fetch.
2. Reload MUST NOT fetch or store article-body text and MUST NOT invoke AI merely because the editor requested metadata refresh.
3. The fetched result SHOULD be presented for editor review before mutation when it differs from stored state.
4. A missing `og_image_url` MAY be filled from a newly discovered valid publisher preview image after explicit apply.
5. If `og_image_url` is already non-null and reload discovers a different valid image, the existing image MUST NOT be replaced silently. The editor must explicitly choose to replace it unless a narrower source-specific contract provides a bounded safe bulk-repair rule.
6. Any future metadata identifying a human/manual image choice MUST be preserved unless the editor explicitly requests replacement.
7. A missing publisher-origin `display_title` MAY be filled from valid publisher metadata, but an existing human or AI display title MUST NOT be overwritten.
8. Reload/apply MUST NOT alter approval, rejection, hidden state, canonical identity, topics, editorial notes or other unrelated article state.
9. Reload/apply MUST use the normal authenticated admin mutation boundary and preserve revision/idempotency/event semantics where applicable.
10. A no-change reload SHOULD report that no usable new metadata was found rather than mutating unrelated fields merely to create activity.

This explicit editorial path is an exception only to the automatic non-overwrite rule insofar as it allows the editor to choose a replacement after seeing the changed publisher metadata. It does not turn automatic rediscovery into an overwrite process.

## 6. Transient cached remote previews

For `image_policy='remote_preview'`, UK AQ MAY proxy the publisher-hosted preview image through `media-public` and use Cloudflare's transient edge cache as a delivery optimisation.

This is distinct from `local_copy_permitted` durable storage.

The cached-remote-preview rules are:

1. the source bytes remain publisher-origin bytes for the same article preview;
2. cache storage MUST be transient Cloudflare HTTP/Cache API storage only;
3. image bytes MUST NOT be written to D1, R2, Git, Dropbox or another durable UK AQ media store under `remote_preview`;
4. the Worker MUST NOT resize, recompress, crop, watermark or otherwise transform the cached bytes;
5. CSS `object-fit: cover` and clipping by the website are presentation only and are permitted;
6. the cache MUST have a finite TTL. The initial implementation SHOULD use 24 hours;
7. a cache miss MAY fetch only the validated `og_image_url` associated with the requested approved article;
8. image fetches MUST use HTTPS, reject redirects, require an `image/*` content type, use a bounded timeout and enforce a conservative response-size limit;
9. the initial implementation SHOULD use a 10-second timeout and a 5 MiB maximum image size;
10. failed, blocked, oversized, redirected or non-image responses MUST fail closed and MUST NOT be cached as successful images;
11. public article JSON MUST remain usable when the image route fails;
12. once an article/source no longer exposes a permitted image, normal public pages MUST stop referencing the cached image route. A finite cache TTL bounds residual edge copies.

`local_copy_permitted` remains reserved for a durable copied/stored image where an explicit permission/licence or another clearly documented right has been established. This contract does not make that determination.

## 7. Versioned public API/image route

`media-public` MAY expose a narrow read-only image route keyed by article identity, for example:

```text
GET /article-images/:id?v=<image-version>
```

The exact path/query shape is an implementation detail, but the route MUST:

- serve only an image associated with an approved article whose source/article image policy permits `remote_preview`;
- perform no editorial mutation;
- reveal no D1 credentials, source-policy internals, secrets or full publisher image URL in the public version parameter;
- return a normal non-success status when the article/image is unavailable or blocked;
- use the transient caching rules above;
- set safe response headers appropriate to an image response.

### 7.1 Current image version and cache identity

The public `/articles` response SHOULD expose a versioned `preview_image_url` suitable for website use. Its version token MUST be derived deterministically from a collision-resistant digest of the exact current stored `og_image_url`; a compact truncated digest is acceptable when collision risk remains negligible for this use.

The image Worker MUST independently derive the expected current version from D1. The caller-supplied `v` value is an assertion/reference to a version, not authority over what publisher URL or Cache API entry is used.

The Worker MUST construct its internal Cache API identity from the current D1-derived image version. Arbitrary query parameters MUST NOT control cache identity. Changing `og_image_url` therefore produces both a new public `preview_image_url` and a new internal cache key, allowing prior transient entries to age out without explicit purge.

Unversioned legacy image requests MAY remain usable. If supported, they MUST still resolve/fetch/cache using the current D1-derived image identity rather than an unversioned caller-controlled key.

### 7.2 Stale explicit image versions

An otherwise valid request whose supplied `v` token refers to an older image version MUST NOT fail merely because the article's stored `og_image_url` has since changed.

When the article remains approved and currently has a permitted `remote_preview` image, a stale explicit version SHOULD resolve to the current versioned image URL, preferably by a short/no-store redirect to the canonical current `preview_image_url`. Serving the current bytes directly is acceptable only if doing so does not allow the stale request URL to become a long-lived browser/cache identity that can survive another later image change.

The stale-version response MUST NOT:

- fetch the old publisher URL;
- read from or write to an obsolete Cache API identity selected by the caller;
- expose the current publisher URL;
- weaken article/source image-policy checks;
- create a redirect loop;
- turn arbitrary query parameters into cache-key selectors.

A request with no current permitted image, a non-approved article, or a blocked source/article policy MUST still fail normally rather than redirecting to an image that is no longer authorised.

This stale-version behaviour exists to cover the short period in which a client may still hold an older cached `/articles` response after `og_image_url` changes. It does not require preserving historical image versions.

### 7.3 Public feed and bridge

The public `/articles` response SHOULD expose the UK AQ versioned image-delivery URL while retaining the original `og_image_url` only if existing public compatibility requires it. New website presentation SHOULD prefer the UK AQ image-delivery URL so publisher traffic is bounded by the edge cache.

For deployed TEST website use, `media-public /articles` is the authoritative upstream behind the same-origin `GET /api/media/articles` bridge owned by `../cache_proxy/media-public-feed-contract.md`. The bridge SHOULD relay the public article response rather than reconstructing Media data in Ops.

The `preview_image_url` returned by Media remains an absolute Media public image-delivery URL. It MUST NOT be rewritten by the Ops bridge into a second image-proxy route.

## 8. Main AQ in the News page handoff

The website's visual card geometry and responsive behaviour belong to `../website_ui/news-page-contract.md`.

Media MUST provide enough public data for that UI to render:

- original `title`;
- optional `display_title` and `display_title_origin`;
- publisher;
- publication/discovery date as already contracted;
- article URL;
- optional versioned cached-preview delivery URL;
- existing optional summary/topics/context fields.

The Media API remains useful when any optional image or compact-title field is null.

The deployed TEST page SHOULD request the same-origin `/api/media/articles` route rather than containing environment-specific Media Worker URLs. Local development MAY emulate that same route with the local server. LIVE routing remains deferred until explicit public-site cut-over.

## 9. Validation boundary

Before implementation, validate only structural viability: migration compatibility, Worker binding/API shape, bounded fetch/cache design, deterministic URL-derived versioning, stale-version redirect/serve shape, explicit metadata reload/apply semantics and compatibility with existing source-policy enforcement. AI-title structural validation belongs to `media-display-title-ai-contract.md`.

For a source-specific publisher CDN addition, a targeted pre-implementation evidence check is required only to identify the exact hostname currently supplied by the publisher and confirm that the existing source-specific URL-validation shape can represent it without a wildcard or broader fetch-policy change. This is a contract-boundary check, not a speculative functional test suite.

For the TEST same-origin feed bridge, the cache-proxy-specific structural and post-deployment requirements are owned by `../cache_proxy/media-public-feed-contract.md`.

After deployment, use real TEST operation to confirm at least:

- bounded article-head presentation-metadata retrieval obtains permitted metadata for real `remote_preview` sources where available without retaining article-body content;
- BBC News RSS preview metadata on the explicitly permitted `ichef.bbci.co.uk` host can populate a previously absent image, and the authenticated metadata-reload path can propose/apply a valid BBC image when one is available;
- a BBC or other publisher image on a non-permitted external hostname remains rejected rather than causing a broader hostname exception;
- automatic rediscovery fills previously absent preview metadata without overwriting existing non-null image choices;
- explicit editorial/source-specific repair preserves unrelated article/editorial state;
- the public cached image route serves permitted images and rejects blocked/invalid/non-image/oversized responses;
- publisher image bytes are not written to durable UK AQ storage under `remote_preview`;
- `preview_image_url` is versioned from the current stored publisher image URL and changes when that URL changes;
- internal Cache API identity changes with the current stored URL/version and cannot be selected by arbitrary request query parameters;
- an old explicit version URL no longer returns a broken image merely because the article has moved to a new valid image version, and instead resolves safely to the current version without reviving the old cache identity;
- unversioned legacy requests, if retained, use the current D1-derived cache identity;
- the public article feed remains usable when an image is unavailable;
- original publisher titles remain preserved while compact display titles remain optional;
- the deployed TEST AQ in the News page renders the public response correctly through its same-origin feed route.

Do not create a speculative pre-implementation functional test suite for this slice. Functional evidence comes from the deployed TEST path.