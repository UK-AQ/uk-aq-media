# TEST publisher metadata acceptance

Run this procedure after the operator has approved TEST deployment. Phase 1 adds bounded metadata enrichment and repair. King's College London direct discovery requires separate first-party markup verification and implementation.

## Deployment and baseline

1. Record the approved TEST revision. Use the existing TEST **Deploy UK AQ Media** workflow. Check that it applies D1 migration `0069_publisher_metadata_work.sql` before deploying the Workers, and verify the Public, Admin and Discovery deployments in the TEST account.
2. Confirm `NEWS_EMAIL_ENABLED=false` in the TEST configuration. Use the authenticated `GET /admin/bluesky/settings`, `GET /admin/facebook/settings` and `GET /admin/threads/settings` responses to confirm `publishing_enabled` is false for Bluesky and Facebook and manual and automatic publishing are both disabled for Threads. Keep those settings disabled throughout. Record the current queue and publication counts before discovery.
3. Record `GET /admin/health`, `GET /admin/runs?limit=20`, `GET /admin/runs/gdelt?limit=10` and the GDELT checkpoint before starting. Use the existing TEST Admin URL and bearer token. Keep tokens out of transcripts, saved evidence and shell history.

## Discovery and automatic enrichment

1. Let the next TEST scheduler run execute, or submit one authenticated `POST /scheduler/run` against the existing TEST Discovery Worker with the `x-uk-aq-worker-http-secret` header. Confirm HTTP 202 and a successful run in Admin for at least three real routes. Include an RSS publisher, a publisher index, and a specialist route such as OpenAQ, the Guardian or Sky. Match evidence to article IDs and the route run.
2. Let the TEST GDELT workflow run or manually dispatch the existing **Discover UK AQ Media through GDELT Web NGrams** workflow in the TEST repository on its deployed main revision. Record the workflow run, completed file/chunk and checkpoint. From that run select persisted article IDs across multiple publishers, including a dynamic publisher if present. Use Admin article detail or read-only D1 to capture initial publisher, headline, date, author, image, source and provenance.
3. After the next normal scheduler run, correlate the IDs with `media_article_metadata_work`. Verify that promoted articles remain the same IDs and hashes, and that the checkpoint advances independently of failed publisher requests. For a real article with an image and missing author or date, confirm that available publisher metadata fills each missing field while the original image remains. Compare dates with publisher evidence and confirm date-only values remain date-only. Compare any changed dynamic label with the publisher evidence and the unchanged source key/domain.
4. Include a direct publisher route with more than three newly admitted articles. Inspect an exact publication suffix beyond the third inline lookup. Its raw headline should remain until deferred enrichment verifies the publisher article. If an explicit article headline includes the suffix as headline text, confirm that wording remains. If it identifies site branding, confirm one exact suffix is removed. Compare IDs, editorial states and manual title edits before and after enrichment.
5. Record examples where the publisher omits a field, a domain or policy disallows lookup, or the publisher returns a transient error. Terminal results have `next_at` null. For real transient results, compare `attempts` and `next_at` on successive scheduler turns. The policy allows at most four publisher attempts, with 15-minute, two-hour and twelve-hour delays before subsequent scheduler eligibility. A scheduler turn dispatches up to 16 article messages by default, with `MEDIA_METADATA_DISPATCH_LIMIT` bounded to 1–32 in the existing Discovery Worker Wrangler vars, each independently claimed for five minutes. A direct scan makes up to three inline metadata resolutions and admits at most its existing route limit. The shared HTML fetch reads at most 256 KiB in ten seconds with up to three validated redirects. Existing specialist fallback requests have their own bounds. For capacity, record the due work count, oldest `next_at`, dispatched and completed counts, Queue depth, Worker duration/subrequests and D1 rows before and after several normal TEST cycles. The default permits at most 192 dispatches per day at the two-hour cadence. Any adjustment through `MEDIA_METADATA_DISPATCH_LIMIT` requires a reviewed config deployment and must stay within 1–32, or 384 daily dispatches. Queue messages can repeat before a claim, and each claimed article has bounded publisher requests and D1 writes. Set the operational value from real backlog and resource observations. Check Cloudflare Worker, Queue and D1 metrics around the baseline, especially subrequests, rows read/written, retries and any growing backlog.

Record per-article outcomes with a bounded read-only query on the TEST D1 database. Substitute the IDs recorded above.

```sql
SELECT a.id, a.source_key, a.canonical_url_hash, a.status, a.approval_method,
       a.approved_at, a.author, a.published_at, a.og_image_url,
       w.status AS metadata_status, w.attempts, w.next_at, w.reconcile_pending, w.checked_at
FROM media_articles a
LEFT JOIN media_article_metadata_work w ON w.article_id = a.id
WHERE a.id IN (/* operator-selected article IDs */)
ORDER BY a.id
LIMIT 10;
```

## Manual addition and representative historical repair

1. After both TEST PRs have been approved and deployed, look up a real first-party publisher URL through the dashboard Search / Add article workflow. Compare the proposed headline, publication, date, byline and permitted image to the publisher evidence. Confirm that a publisher date without a time stays date-only in the form and stored article, while a date with a time retains its UTC time. Add a new article as Pending, then look it up again and verify the same article ID. Open **Reload metadata** and check the proposal. Exercise OpenAQ or Sky when a matching real item is available.
2. In the dashboard Reload metadata dialogue, select a headline, publication and author change independently from an image, compact title and publication-date change. Confirm an unselected change stays unchanged in article detail. Try one image replacement with its explicit confirmation, then cancel another. Confirm any failed or rejected save leaves the reviewed changes visible and does not report success. Exercise a dashboard connected to an older Media Admin response that lacks the new proposals if such a deployment is available.
3. Select at most ten existing IDs for one repair batch. Use several publishers and a mix of editorial statuses, a valid image with an incomplete byline/date, a verified wrapped headline, and an article with an existing manual correction or human/AI display title. Record each article detail and approval, social and email history before applying anything. For a relevant approved article also record the public article and homepage generation.
4. Preview each selected ID individually. Save the complete response for review and retain the article ID, revision and each before/proposed pair. The existing authenticated endpoint exposes the author, publication and exact headline proposals alongside image, compact title and publication date proposals.

```sh
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${UK_AQ_MEDIA_ADMIN_TOKEN}" \
  "${UK_AQ_MEDIA_ADMIN_URL}/admin/articles/${ARTICLE_ID}/metadata/preview"
```

5. Authorise only the fields justified by real publisher evidence. Create one JSON object per ID from the preview using the mapping below. Omit unapproved optional fields. For this repair exercise, leave `replace_existing_image` false. Use one unique, stable idempotency key per reviewed request.

| Apply field | Value |
|---|---|
| `expected_revision` | `article.revision` |
| `expected_current_image_url` | Stored `og_image_url` from article detail, or null |
| `expected_proposed_image_url` | `changes.image.proposed` if filling a missing image, otherwise null |
| `replace_existing_image` | false |
| `apply_publisher_display_title` | false unless explicitly approved for an empty display title |
| `exact_headline` | `changes.exact_headline` if approved |
| `publication` | `changes.publication` if approved |
| `author` | `changes.author` if approved |
| `expected_current_published_at` | null when applying a missing publication date |
| `expected_proposed_published_at` | `changes.published_at.proposed` when applying a missing publication date |
| `apply_publisher_published_at` | true only when applying the reviewed date |

```sh
curl --fail-with-body --silent --show-error \
  --request PUT \
  --header "Authorization: Bearer ${UK_AQ_MEDIA_ADMIN_TOKEN}" \
  --header "Idempotency-Key: ${METADATA_REPAIR_KEY}" \
  --header 'Content-Type: application/json' \
  --data-binary "@${REVIEWED_REPAIR_JSON}" \
  "${UK_AQ_MEDIA_ADMIN_URL}/admin/articles/${ARTICLE_ID}/metadata/apply"
```

6. If the revision or proposal changed, request a fresh preview and review it before applying a new request. If the response is lost or syndication refresh returns HTTP 503, repeat the identical request with its original key. Confirm one `admin:metadata:` edited event with the reviewed before/after values. Confirm stable canonical identity, editorial status, approval history, existing valid fields and manual titles/clears. Check public and homepage presentation and syndication evidence where affected. Compare social and email history with the baseline and confirm zero external sends resulting from repair.

## Canonical identity and HTTPS fetch correction

1. After approval, deploy the TEST Media PR through **Deploy UK AQ Media**. Once Admin and Discovery are healthy, deploy the TEST Ops PR through **Deploy UK AQ Ops Dashboard to Cloudflare Pages**. This correction introduces no migration. Keep the external delivery settings in the baseline section disabled throughout.
2. Before any edits, open existing TEST article `77367` through the dashboard Media URL search. Record `id`, `source_key`, `original_url`, `canonical_url`, `canonical_url_hash`, `status`, `approval_method`, `approved_at`, `rejected_at`, `hidden_at`, and the approval event IDs using authenticated `GET /admin/articles/77367` or read-only TEST D1. Record its current Bluesky, Facebook and Threads publication rows and its `media_news_approval_events` and associated email outbox/delivery rows. Record the existing `media_article_metadata_work` outcome if present. Leave that work row in place.
3. With Cloudflare Observability open for the deployed TEST Admin Worker, select **Reload metadata** and inspect the `POST /api/media/articles/77367/metadata/preview` response in the browser Network panel. Expect HTTP 200. Correlate the invocation with the `article_metadata_redirect` event. For the historical apex row, expect `reason=http_scheme`, `from_host=kcl.ac.uk`, `https_host=www.kcl.ac.uk`, `recovery_attempted=true` and `recovery_succeeded=true`. That event confirms the direct HTTPS alternate returned usable HTML to the Worker. If it fails, record only the bounded diagnostic and leave the row unmodified.
4. Compare the actual returned `metadata.publisher`, `explicit_headline`, `published_at`, `image_url`, `author` and proposals with the real publisher page. The operator's local resolver confirmed the publication, explicit headline and permitted image. The article-specific `datePublished` value `2026-11-24T00:00:00` should now return `2026-11-24` without a time. Record any fields genuinely unavailable. No individual author has been established. Select only verified useful changes and use **Apply selected changes**. Apply a date only if the stored date is missing, a proposal is offered, and no manual correction or clear is protected. Open a comparable real article with a manually corrected publication date and verify that reload offers no publication-date change.
5. Re-read `77367` and compare the identity, original URL, editorial state and approval history with the baseline. Expect only the selected metadata and its audited `edited` event to change. Verify the article's social publication and News email rows show no new publication intent or delivery caused by the repair.
6. Find a genuinely new, relevant article on a permitted publisher whose apex and `www` URLs canonicalise to the same article. Use its original HTTPS `www` URL in the dashboard. Verify `POST /api/media/articles/lookup` returns `original_url` with the supplied hostname, path and any meaningful query, and a separate `canonical_url`. Choose **Add Pending**, verify that `POST /api/media/articles` submits the same original URL, and confirm the stored values through article detail. Search both URL forms and confirm both return that same ID/hash with no second add option. Repeat the two URL lookups for `77367` and confirm they open the existing article.
7. Use the normal TEST discovery and GDELT procedures above. Exercise a real generic RSS route such as Phys.org, a publisher index such as DSAWSP or CAWS, and newly promoted GDELT items from multiple publishers. Compare observed original URLs with the stored provenance and check canonical overlap, work outcomes, run limits and GDELT checkpoints. Verify OpenAQ remains RSS-only, Guardian uses its authorised RSS image workflow, Sky retains its bounded RSS fallback when the publisher returns 403, and a real blocked publisher or unrelated prohibited redirect remains refused when available. Review the existing Bluesky external-card policy with TEST sending disabled. Record any real cases that did not occur as pending. Compare social and email delivery counts with the baseline after the runs.

## King's College London direct discovery (Phase 2)

During the earlier listing investigation, the cloud fetch proxy rejected HTTPS connections to `www.kcl.ac.uk/news/search`, `/news`, `/news/kings-news`, the reference article and the apex search URL with HTTP 403 before returning a publisher response. The earlier HTTP 429 on the alternate listing was reported in the contract. Listing markup and selectors still require first-party verification. Record this Phase 2 blocker separately from article metadata acceptance.

Once the public listing and article markup can be verified in the intended fetch environment and the adapter has been approved and deployed, repeat direct discovery for `kings-college-london-news`. Compare the bounded listing with the run and health entry. Verify recent relevant items enter the manual initial review path, unrelated university stories are filtered, first-party publisher metadata resolves subject to its permissions, and a real overlap with GDELT shares one ID/hash and retains both provider observations. Use the 24 November asthma story only if present in the bounded listing or already stored. Record real cases that did not occur during the window and keep them open for acceptance.

## Rollback

Use an approved TEST rollback to the previous Worker revision if enrolment, claims or resource use regress. The additive table can remain for the previous revision. Drain or pause the TEST discovery consumer as appropriate before rollback so outstanding `article_enrich` messages are accounted for. The previous consumer may retry them as unsupported. The migration adds no historical rewrite. Existing metadata repairs are audited and persist across a code rollback. Review any data reversal by article ID against its before/after evidence and current revision.
