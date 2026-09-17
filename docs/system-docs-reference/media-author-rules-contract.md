# UK AQ Media author rules contract

**Status:** Current narrow authority for author-specific discovery inclusion and publication behaviour, and for normalising redundant article-author metadata. This contract supplements `media_contract.md` and supersedes its source-wide manual-publication rule only where an explicitly configured author rule says otherwise.

## 1. Purpose

UK AQ Media MUST support explicit author-level rules in addition to source-level and topic-level rules.

An author rule exists so UK AQ can deliberately follow a named journalist/scientist whose work is consistently useful even when an individual article would not match the normal air-quality topic filters.

Author rules MUST remain explicit configuration. Merely recognising an author name in a feed MUST NOT create a trusted-author rule automatically.

This contract also defines the narrow normalisation rule for article author metadata when a publisher supplies its own publication name as the author. That metadata-cleanliness rule applies to all Media sources and does not itself create, remove or alter an author-specific inclusion/publication rule.

## 2. Rule dimensions

Author inclusion and publication are separate decisions.

The implementation MUST be able to represent at least:

```text
inclusion_policy:
  normal
  always_include

publication_policy:
  inherit_source
  pending
  auto_approve
```

`always_include` means an article by that verified author is in scope even if it does not match the normal AQ keyword/topic relevance rules.

`pending` means a newly discovered, otherwise-new article enters the normal Pending editorial queue.

`auto_approve` means a newly discovered, otherwise-new article may enter Approved automatically under the explicit author rule.

An author rule MUST NOT silently change the publisher's general policy for articles by other authors.

## 3. Author identity

Author matching MUST be tied to the publisher/source identity and SHOULD prefer a stable publisher-native author/profile identity over free-text name matching.

For Guardian profile-feed discovery, the configured profile URL/feed itself is sufficient strong evidence of the author identity for entries returned by that feed.

When an article is discovered through a broader feed such as a topic or section feed, author matching SHOULD use publisher-native author/profile metadata when available. If only a byline string is available, matching MUST use a narrow configured alias for the same source and MUST NOT use fuzzy surname-only matching.

Co-authored articles MAY satisfy an author rule when the configured author is positively identified as one of the authors.

The implementation MAY keep a stable internal `author_key`, for example:

```text
guardian:gary-fuller
guardian:damian-carrington
guardian:fiona-harvey
```

The exact schema is an implementation detail.

### 3.1 Redundant publication-name author metadata

`media_articles.author` is optional person/byline metadata. A publisher or feed sometimes supplies the publication name itself in the author field, which creates redundant presentation such as showing `OpenAQ` as both publisher and author.

Before author metadata is persisted to `media_articles.author`, Media MUST compare the candidate author with the article's publication/publisher name. If they are exactly equal after trimming surrounding whitespace and comparing case-insensitively, the stored author MUST be `NULL`.

This is an exact-match rule apart from case and surrounding whitespace. It MUST NOT use fuzzy matching, punctuation removal, alias matching, substring matching or semantic equivalence. For example:

```text
publisher: OpenAQ    author: OpenAQ       -> NULL
publisher: OpenAQ    author: openaq       -> NULL
publisher: OpenAQ    author: OpenAQ Team  -> "OpenAQ Team"
```

The rule applies consistently to publisher RSS metadata, bounded publisher-head metadata when an author is applied, manual/article-management metadata paths and any later discovery provider that can populate `media_articles.author`.

Author-rule matching MAY use the raw publisher-native byline evidence before this storage normalisation where needed. Suppressing a redundant stored author MUST NOT prevent a legitimate configured author rule from matching independent publisher-native evidence.

Rediscovery MUST NOT reintroduce a redundant publication-name author after it has been normalised to `NULL`. If a later valid observation supplies a genuinely different author while the stored author is `NULL`, normal metadata precedence rules MAY populate that real author.

Existing rows that already have an author equal to their publisher under this same comparison rule SHOULD be normalised once to `NULL` so current public/admin presentation is corrected. That bounded cleanup MUST NOT change article identity, publisher, editorial status, approval provenance, rejection/hidden state or unrelated metadata.

## 4. Initial Guardian author rules

The first Guardian adapter MUST support these explicit rules:

| Author | Guardian profile | Inclusion | New-article publication |
|---|---|---|---|
| Gary Fuller | `https://www.theguardian.com/profile/gary-fuller` | `always_include` | `auto_approve` |
| Damian Carrington | `https://www.theguardian.com/profile/damiancarrington` | `always_include` | `pending` |
| Fiona Harvey | `https://www.theguardian.com/profile/fiona-harvey` | `always_include` | `pending` |

These rules apply to all articles positively identified as being by the named author, not only articles whose title/feed metadata independently matches an AQ topic.

Gary Fuller's rule is intentionally stronger: his positively identified Guardian articles are always in scope and may be auto-approved.

Damian Carrington and Fiona Harvey are always in scope, but their newly discovered articles remain Pending because their wider environmental reporting includes material outside air quality.

The Guardian source as a whole remains `manual` / `standard`. These author rules are narrow exceptions and MUST NOT auto-approve other Guardian writers.

## 5. Initial Guardian discovery routes

The initial Guardian adapter SHOULD discover through overlapping publisher-native RSS routes. Overlap is intentional and MUST be resolved through the normal canonical article identity rather than by trying to make the feeds mutually exclusive.

### 5.1 Author profile feeds

```text
https://www.theguardian.com/profile/gary-fuller/rss
https://www.theguardian.com/profile/damiancarrington/rss
https://www.theguardian.com/profile/fiona-harvey/rss
```

The three profile feeds provide deliberate author coverage.

The profile feeds MUST NOT be subjected to the normal AQ relevance gate before `always_include` is applied. Their articles are included because the configured author rule selected the feed.

### 5.2 Direct AQ feed

```text
https://www.theguardian.com/environment/air-pollution/rss
```

The Guardian Air Pollution feed is already sufficiently specific to the Media subject area that its otherwise-new articles MAY enter Pending directly under the normal Guardian `manual` / `standard` policy, subject to canonical identity and any matching author rule.

### 5.3 Broader filtered Guardian feeds

The first Guardian adapter SHOULD also use these broader feeds as discovery safety nets:

```text
https://www.theguardian.com/environment/rss
https://www.theguardian.com/environment/pollution/rss
https://www.theguardian.com/uk/rss
https://www.theguardian.com/world/rss
https://www.theguardian.com/environment/climate-crisis/rss
https://www.theguardian.com/science/rss
https://www.theguardian.com/technology/rss
```

These broader feeds MUST pass through the normal deterministic AQ relevance filter before an article is accepted into Pending, unless an explicit author rule independently makes the article `always_include`.

The purpose of the broader feeds is recall, including UK and international air-quality material that may not be tagged by The Guardian specifically as `Air pollution`. Examples may include wildfire smoke, indoor air, traffic/transport emissions, atmospheric chemistry, pollution-health research, air-monitoring technology or other AQ-related reporting appearing under World, Climate crisis, Science, Technology or general Environment/UK coverage.

A generic article from one of these broad feeds MUST NOT reach Pending merely because it appears in the feed. It must either satisfy the configured deterministic AQ relevance rules or match an `always_include` author rule.

The Guardian UK feed is a front-page/index feed and MUST NOT be treated as a complete feed of every Guardian article. It is an additional bounded discovery route only.

A future Guardian discovery route may be added without changing these author rules, provided canonical identity/deduplication, relevance handling and source-content policy remain consistent.

## 6. Interaction with canonical deduplication

The same Guardian article may appear in an author profile feed, the Air Pollution feed, one or more broader Guardian feeds, GDELT or another later route.

All routes MUST converge on the same canonical article identity before creating state.

A duplicate sighting MUST NOT create a second article row or a second publication event.

Where an already-known `pending` article is later positively identified as Gary Fuller through the configured author rule, the system MAY promote it to Approved through a single author-auto-approval transition with truthful provenance.

An article already `approved` remains Approved without a duplicate transition.

An article already `rejected` or `hidden` MUST NOT be automatically resurrected by an author rule. Human editorial rejection/hiding takes precedence over rediscovery, including Gary Fuller's auto-approve rule.

## 7. Approval provenance

Author-based auto-approval MUST be distinguishable from Air Quality News source-wide auto-approval and from manual approval.

The implementation MUST retain enough provenance to identify:

- the publisher/source;
- the matched author rule;
- whether the rule caused `always_include`;
- whether the rule caused automatic approval;
- the discovery route/provider that observed the article.

It MUST NOT falsely record Gary Fuller's author-specific approval as though The Guardian as a whole were a trusted auto-approved source.

The exact schema is an implementation detail. An approval method such as `trusted_author_auto`, or an equivalent explicit event/provenance representation, is acceptable provided the distinction is durable and queryable.

Existing append-only event, revision and idempotency semantics MUST be preserved.

## 8. Source-content, AI and image policy

An author rule changes discovery inclusion/publication only. It does NOT grant broader rights to fetch, store or process publisher content.

For The Guardian, source-content, AI and image behaviour is governed by the applicable Media contracts, including the narrower [`media-guardian-rss-preview-contract.md`](media-guardian-rss-preview-contract.md) where it supersedes broader image restrictions.

In particular, `always_include` or `auto_approve` MUST NOT by itself enable:

- article-body fetching;
- article-body storage;
- AI processing of Guardian article text;
- image access beyond the explicitly permitted Guardian RSS remote-preview path.

Guardian RSS/profile metadata may be used only within the applicable source-policy boundary. The current Guardian preview policy permits RSS-supplied remote preview images under the narrower Guardian RSS preview contract; it does not authorise Guardian article-head/body fetching or arbitrary image hosts.

## 9. Rule changes

Author rules MUST be configuration-driven so they can be added, changed or removed later without deleting article identities.

Changing or removing an author rule affects future discovery/publication decisions. It MUST NOT silently rewrite the status of already-stored articles.

A deliberate later backfill/reclassification operation MAY be designed, but it must be explicit and preserve article/event provenance.

## 10. Admin/dashboard compatibility

The future Media admin/dashboard MAY expose author rules for inspection or editing, but author-rule editing is not required by the first Guardian adapter.

If exposed later, changes MUST flow through the authenticated `media-admin` boundary to authoritative D1/configuration. The browser MUST NOT receive direct D1 credentials.

At minimum the editorial view SHOULD be able to show when an article was included or auto-approved because of an author rule so the decision is understandable.

## 11. Structural validation boundary

Before implementation, validate only structural viability of:

- representing author rules without making The Guardian source-wide auto-approved;
- obtaining stable author identity from the configured Guardian profile feeds and, where available, broader-feed author metadata;
- representing all configured Guardian RSS routes as bounded route work without making one source scan unbounded;
- applying deterministic AQ relevance filtering to the broader Environment, Pollution, UK, World, Climate Crisis, Science and Technology feeds;
- allowing the specific Air Pollution feed to feed Pending directly under Guardian's normal manual policy;
- deduplicating overlap among all Guardian feeds and other discovery routes;
- representing author-specific auto-approval provenance distinctly from `trusted_source_auto`;
- preserving rejected/hidden precedence over author auto-approval;
- keeping Guardian content/AI/image behaviour within the applicable source-specific contracts;
- enforcing publication-name author suppression at the storage boundary without weakening author-rule matching or later real-author population.

A targeted pre-implementation check of the configured Guardian RSS endpoints is justified because those exact publisher-native routes are the adapter inputs. This check is limited to confirming reachability/parseable RSS and expected article identity/date/author metadata. It is not a speculative functional test suite.

After deployment, validate through real TEST Media operation that:

- Gary Fuller feed items are discovered regardless of AQ topic wording and new items auto-approve;
- Damian Carrington and Fiona Harvey feed items are discovered regardless of AQ topic wording and new items enter Pending;
- other Guardian Air Pollution feed items enter Pending under the normal Guardian source policy;
- broad Guardian feeds contribute only items accepted by the deterministic AQ relevance filter or an `always_include` author rule;
- UK and international AQ-relevant Guardian coverage can be discovered from the broader feed set;
- overlapping feed sightings produce one canonical article identity;
- rejected/hidden articles are not resurrected;
- author-auto-approval provenance is correctly distinguished from AQN source auto-approval;
- redundant publication-name authors such as `OpenAQ`/`OpenAQ` are stored as `NULL` and no longer render twice;
- a later genuinely different author can populate an article whose redundant author was normalised to `NULL`;
- Guardian article-content and AI restrictions remain enforced while permitted RSS-supplied remote preview images follow `media-guardian-rss-preview-contract.md`.