# Research, DOI and shared topics system contract (proposed)

Status: design contract only. No D1 migration, API implementation or production change is authorised by this document.

## Scope and ownership
The existing UK AQ Media production D1 database remains the system of record for news and the planned Research catalogue. Preserve existing media_articles fields, source policy, approval states and ingestion behaviour. Do not add a single DOI column to media_articles. Research is independent of the News editorial workflow, but the two catalogues can be linked.

## Relational model
- research_papers: id primary key, canonical_title, abstract, authors metadata, subject/country metadata, canonical_paper_url, open_access_url, editorial_status (Pending/Approved/Rejected/Hidden), created_at, updated_at. Use internal paper ID as identity, not DOI. Include provenance and source licensing controls. Store paper-level first-publication date separately from version dates where reliably known.
- research_paper_publications: id primary key, paper_id foreign key, version_type (preprint/accepted/final), doi_normalized nullable, publication_url, venue, publisher, first_online_date, issue_date nullable, discovered_at, updated_at. Unique non-null normalised DOI globally unless an explicitly documented DOI correction/alias mechanism is needed. Multiple publication versions may belong to one research paper. Do not mark preprints or accepted manuscripts as final peer-reviewed publications.
- media_article_research_papers: article_id and paper_id foreign keys, relationship (reports_on/cites/discusses/critiques), provenance, created_at, composite unique(article_id,paper_id). Multiple articles may link to a paper and one article may link to multiple papers. If multiple relationships must be represented, define a separate relationship record or controlled multi-value representation before implementation.
- topics: id primary key, unique slug, unique display name (case-insensitive normalisation), description, nullable parent_topic_id, is_active, display_order, created_at, updated_at. Prevent parent cycles. Never silently delete a topic that has assignments. Topic merge must remap both link tables transactionally and retain aliases or redirects for old slugs.
- media_article_topics: article_id and topic_id foreign keys, assignment_source (manual/discovery/ai), created_at, unique(article_id,topic_id).
- research_paper_topics: paper_id and topic_id foreign keys, assignment_source (manual/discovery/ai), created_at, unique(paper_id,topic_id).

Choose actual column types, foreign-key delete rules and timestamps to match existing D1 migrations and conventions. Index both directions of each link, topic slugs, editorial status, version publication dates and normalised DOI. Enforce referential integrity and validate all enumerated values. Prefer soft removal for editorial records and topics to preserve audit history.

## DOI and identity rules
Normalise DOI input by trimming whitespace, decoding safe URL forms, stripping doi.org / dx.doi.org and doi: prefixes, and case-folding the DOI identifier for comparison. Validate before storage and preserve the original publisher URL separately. Search both publication DOI and paper title/author/venue metadata for duplicates; title similarity alone must not silently merge different papers. Crossref, OpenAlex, Europe PMC and publisher identifiers are evidence, not automatic proof of identity. Record aliases and corrections with provenance. A preprint and later final publication may have different DOIs and dates. Resolve their relation before grouping them as one research paper.

## Discovery and editorial contract
News discovery may extract zero or more DOI references, resolve or create candidate papers and create evidence-backed article-paper links. Research discovery independently checks publishers, journal recent pages, Crossref, Europe PMC, OpenAlex and research-institute releases. Cover source apportionment, residential wood burning, biomass combustion, chemical tracers, black carbon and geographical terms including Eastern Europe and the Balkans. Keep original publication date separate from discovery/index/update timestamps. Record version status accurately. A newly published news explanation of an older paper is new News, not new Research. Support a rolling seven-day late-discovery window separately from same-day results.

Each catalogue has independent Pending/Approved/Rejected/Hidden editorial status and independent public visibility. Linking a news article must never auto-approve a paper, and vice versa. Preserve existing Media article status and source permissions. AI-derived topics and DOI associations are suggestions with provenance and must support editorial correction. Metadata-only sources must not have their article body retained or passed to AI without permission.

## Public and admin API contracts
Plan paginated public News and Research listing/detail endpoints with topic slug filters, stable sorting, counts and related-item links. Public endpoints expose only Approved and otherwise publicly eligible records. Multiple selected topics require an explicit documented AND/OR rule, applied consistently across News and Research. Avoid duplicate result rows from many-to-many joins. Topic counts must respect visibility and the active filters. Public research details should distinguish preprint, accepted and final versions, show original online date, journal issue date if different, DOI links and related approved news.

Admin contracts must support topic create/edit/deactivate/merge, manual topic assignment/removal on either content type, paper-version management, DOI corrections, paper linking/unlinking and independent editorial review. Require authentication, validation, auditability and idempotent operations.

## Migration and rollout requirements
1. Inspect existing schema, naming conventions, D1 migrations and API contracts before writing SQL.
2. Add new tables and indexes additively; do not destructively change media_articles or overwrite existing article topic/category metadata.
3. Backfill topics from existing structured publisher tags only with source provenance and explicit mapping; do not assume tags are globally equivalent topics.
4. Test duplicate DOI variants, missing DOI, one-to-many publication versions, many-to-many links, topic merges, hidden/rejected filtering, publication-date distinctions and foreign-key behaviour.
5. Deploy to TEST and validate before LIVE. Migrations and production writes require separate approval. This documentation change does not run them.
