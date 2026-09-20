# UK AQ Media Facebook Page publishing implementation plan

**Date:** 19 September 2026  
**Updated:** 20 September 2026  
**Status:** Active implementation plan; Stage 0, migration/core foundation, dormant Media-admin integration and Meta provider verification complete; remote Facebook publishing remains disabled pending provider/Queue implementation and TEST acceptance  
**Implementation repository:** private `UK-AQ/uk-aq-media`  
**System-docs repository:** `TEST-uk-aq/uk-aq-system-docs`  
**Runtime owner:** UK AQ Media Cloudflare account  
**Target:** Facebook Page `UK AQ - ukaq.co.uk`, Page ID `1336337862891538`  
**Related authority:** [`../../system_docs/media/media_contract.md`](../../system_docs/media/media_contract.md), [`../../system_docs/media/media_bluesky_contract.md`](../../system_docs/media/media_bluesky_contract.md), [`../../system_docs/media/media_facebook_contract.md`](../../system_docs/media/media_facebook_contract.md)

## 1. Purpose

Add controlled Facebook Page publishing to UK AQ Media alongside the existing Bluesky publishing capability.

The Facebook path should reuse the architectural lessons already implemented for Bluesky:

- Media approval state and social publication state remain separate;
- D1 remains authoritative for publication/outbox state;
- Cloudflare Workers and Queues perform publication work;
- credentials remain Worker secrets and are never exposed to browser code, D1, queue messages, logs or documentation;
- failures in Facebook publication do not fail article approval, discovery, the public Media feed, Bluesky publication or the UK AQ website;
- social copy is deterministic and reuses existing Media metadata rather than invoking another AI call;
- manual publication requests are replay-safe;
- publication state is visible to the authenticated operator.

Facebook should be implemented as a parallel social publisher, not as Facebook-specific branches inside `bluesky.ts`.

This plan is non-authoritative. The agreed load-bearing Facebook behaviour is now authoritative in `system_docs/media/media_facebook_contract.md`; this plan records sequencing and completed implementation stages and MUST NOT override that contract. Existing Media and Bluesky contracts continue to own their current areas.

## 2. Current implementation and Meta setup facts checked 20/09/2026

The implementation repository is now `UK-AQ/uk-aq-media`. The former `TEST-uk-aq/uk-aq-media` GitHub URL redirects to that repository. TEST operational acceptance still happens before Facebook publishing is treated as established behaviour.

The current Media implementation already contains a mature Bluesky publishing path that can be used as the reference architecture.

Relevant current files include:

```text
apps/media-discovery/src/bluesky.ts
packages/core/src/bluesky.ts
migrations/0021_bluesky_publications.sql
migrations/0025_manual_bluesky_approval.sql
ref_docs/system_docs/media/media_bluesky_contract.md
scripts/bluesky-publication-check.ts
```

The existing Bluesky implementation already provides or demonstrates:

- dedicated social publication settings;
- durable publication rows;
- an approval-event outbox for eligible automatic publication;
- explicit manual social intent on operator approval requests;
- replay-safe admin request identities;
- a dedicated outbound Queue;
- bounded retry/cooldown behaviour;
- failure isolation from article approval;
- Worker-secret credentials;
- explicit remote identity validation;
- dashboard publication controls and status;
- a queue consumer hosted by the existing Media runtime rather than a browser;
- source/card metadata acquisition through existing Media boundaries.

Facebook work should preserve these boundaries while avoiding unnecessary Bluesky-specific mechanics such as AT Protocol record keys, blob uploads and external-embed records where Meta does not require them.

### 2.1 Meta/Page setup already completed

The operator-side Meta setup is complete and must not be repeated by Codex unless the credential is later invalidated or deliberately rotated.

Established facts:

- Meta app: `UK AQ Media`;
- Facebook Login for Business configuration created for Page publishing;
- Graph API Explorer used with Graph API `v26.0`;
- granted Page permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`;
- target Page: `UK AQ - ukaq.co.uk`;
- target Page ID: `1336337862891538`;
- the account managing the Page has `CREATE_CONTENT` and `MANAGE` tasks for it;
- a long-lived User access token was used to derive the final Page access token;
- Meta's Access Token Debugger reported the final credential as a valid `Page` token with `Expires: Never`, and separately reported a Data Access Expiry;
- using that Page token, `/me?fields=id,name` resolved to Page ID `1336337862891538` and name `UK AQ - ukaq.co.uk`.

`Expires: Never` is observed token-expiry metadata, not a guarantee of permanently unattended operation. The separate Data Access Expiry can require renewed data access/re-authorisation, and the Page token also remains revocable/invalidatable through account, Page, permission or app changes. Runtime code therefore still needs fail-closed identity validation, lifecycle monitoring and a documented credential replacement/re-authorisation procedure.

The runtime credential is the final **Page access token**. The User access token is not required by the Media runtime.

No token value, User token, app secret or other credential may be committed to GitHub, copied into D1, included in Queue messages, returned to browser code, logged, or added to documentation.


### 2.2 Completed provider-independent implementation

Stage 0, migration/core foundation and dormant Media-admin integration are complete and merged.

Implemented foundation:

- migration `0026` exists;
- `media_admin_status_requests` and `media_admin_bulk_status_requests` include `post_to_facebook`;
- `media_facebook_settings`, `media_facebook_settings_requests` and `media_facebook_publications` exist;
- publishing defaults disabled, with the target Page identity configured and `graph_api_version` currently unset pending use by the provider implementation;
- pure `packages/core/src/facebook.ts` deterministic rendering exists;
- durable state includes explicit `unknown_remote_state`;
- no automatic Facebook trigger exists.

Implemented dormant admin integration:

- individual and bulk approval accept optional `post_to_facebook`;
- Facebook intent participates in durable `Idempotency-Key` identity;
- individual and bulk publication rows can be created transactionally;
- Facebook thumbnail eligibility is independent from Bluesky;
- authenticated `GET/PUT /admin/facebook/settings` exists;
- enablement is deliberately rejected with `facebook_publisher_not_configured`;
- article list/detail DTOs expose bounded Facebook state.

No Facebook Queue or Worker secret exists yet. No Meta HTTP call or remote Facebook publisher exists. Facebook remains disabled.

### 2.3 Meta provider verification completed 20/09/2026

The following is **Meta Developer Assistant-confirmed on 20/09/2026** for Graph API v26.0. This records the supplied provider verification; it does not claim that Codex independently fetched Meta's linked reference pages.

- create a Page link post with `POST /{page-id}/feed`, `message`, `link` and the Page access token;
- successful creation returns JSON field `id`, the exact created Page-post ID, which must be persisted;
- exact read-back is available through `GET /{post-id}`, while `GET /{page-id}/feed` reads the Page feed;
- Page feed creation has no supported client-supplied idempotency key/token equivalent;
- for the present app, used only by its own developer/admin for the single Page they manage with the appropriate Page task, App Review, Advanced Access, Business Verification and Live-mode activation are not required for this self-admin development-mode use; this must not be generalised to other users or third-party Pages;
- supplied error examples are `80001` (Page-account rate limiting/too many calls), `100` (invalid parameter), `190` (invalid OAuth token) and `200` (permissions error). These examples do not make arbitrary Graph errors retry-safe.

A permalink may be stored only when returned or obtained through an officially supported exact read-back field. Do not construct one from an assumed URL pattern.

### 2.4 Existing Bluesky bulk-approval repair status

The Ops routing repair for the visible dashboard's bulk **Approved + Post to Bluesky** path has now been merged in `TEST-uk-aq/uk-aq-ops` PR #72.

Repository review and the merged repair establish that:

- the Media backend exposes the authoritative `POST /admin/articles/bulk/approve` path and durable bulk Bluesky publication logic;
- the online Ops dashboard API Worker already translated `/api/media/articles/bulk-approve` to `/admin/articles/bulk/approve`;
- the local Ops compatibility proxy now has matching route support and translation, preserving the bounded body, content type, `Idempotency-Key` and server-side authentication.

That repair closes the known structural local-proxy discrepancy. It does **not** by itself prove the full deployed bulk Bluesky operation.

Before combined Bluesky + Facebook bulk acceptance, complete one real TEST bulk **Approved + Post to Bluesky** operation successfully. If it still fails, capture the returned HTTP status, bounded Media JSON error and request `Idempotency-Key` so the remaining runtime/backend failure can be isolated without re-opening the already-corrected Ops route mapping.

## 3. Proposed V1 product scope

### 3.1 Initial TEST scope

The first Facebook implementation should be **manual publication only** while the Meta authentication, Page identity, link-card behaviour and remote failure semantics are accepted through real TEST operations.

For operator-driven transitions to **Approved**, expose a Facebook control alongside the existing Bluesky control, conceptually:

```text
[ ] Post to Bluesky @ukaq.co.uk
[ ] Post to Facebook <Page name>
```

The Facebook checkbox should default to unchecked.

An unchecked Facebook box must never create a Facebook publication row.

The initial implementation must not automatically publish historical approved articles or scan the public feed for things to post.

### 3.2 Automatic publication is not yet agreed

Whether newly auto-approved articles should automatically publish to Facebook has not yet been decided.

Therefore V1 must not silently copy Bluesky's automatic-publication rule.

The schema/runtime should not block a later extension, but automatic Facebook publication should remain disabled until an explicit product decision is made and recorded in the Facebook contract.

A later agreed phase may add:

```text
auto-approved article
    -> Facebook outbox
```

independently of the Bluesky outbox.

### 3.3 Page identity

The configured Facebook destination is:

```text
Page name: UK AQ - ukaq.co.uk
Page ID:   1336337862891538
```

This identity has already been verified manually with the final Page token.

The stable security identity is the Page ID. The runtime must fail closed before public mutation if the credential resolves to a Page ID other than `1336337862891538`.

A matching Page ID with a changed Page display name should be treated as **configuration/name drift**, not as a wrong credential. The dashboard/operator should surface the drift so the configured display name can be reviewed and updated deliberately.

The Page ID and Page display name are not secret and may be shown in the authenticated dashboard. Access tokens and app secrets are secret.

## 4. Proposed Facebook post shape

V1 should reuse existing publishable Media metadata and should not invoke AI for Facebook-specific copy.

Recommended logical post content:

```text
{original publisher headline}
From {publisher}

Live and historical UK air quality data:
https://ukaq.co.uk/
```

with the canonical publisher article URL supplied separately as the Facebook link target.

The exact editable default-message arrangement should be confirmed during implementation, but the fixed principles should be:

- use the stored original publisher headline, not a pending AI title suggestion;
- do not fetch article body text merely to create Facebook copy;
- do not invent a Facebook summary with AI;
- keep the canonical publisher article URL as the linked article;
- keep UK AQ attribution/configuration separate from publisher metadata;
- use UK English for UK AQ-authored text.

A dedicated Facebook template may be stored in D1 rather than forcing Facebook to reuse the Bluesky template. This avoids coupling two platforms with different formatting/card behaviour.

## 5. Link-preview and image boundary

Facebook V1 uses the Meta Developer Assistant-confirmed Graph API v26.0 Page link-post shape:

```text
POST /{page-id}/feed

message = rendered UK AQ Facebook text
link    = canonical publisher article URL
```

Meta builds the article preview from the canonical publisher URL. Do not copy the Bluesky thumbnail-fetch -> uploadBlob -> explicit external-card pipeline into Facebook.

Facebook link-preview image availability should be treated as platform/publisher metadata behaviour rather than as a new UK AQ image-fetch entitlement.

Do not broaden Media's image permissions merely to force a Facebook thumbnail.

If Meta changes the supported posting contract or the deployed API behaviour materially differs from the provider verification recorded on 20/09/2026, stop and update the authoritative Facebook contract and this plan before implementing an unrelated image-upload workaround.

## 6. Phase 0: completed foundation and provider decisions

Stage 0 repository review, provider-independent schema/core work, dormant admin integration and Meta provider verification are complete. The remaining implementation begins with the server-side provider and dedicated Queue runtime.

### 6.1 Completed repository-side work

Migration `0026`, Facebook settings/request/publication state, deterministic core rendering, independent admin intent and bounded DTO state are merged. The admin API intentionally refuses enablement with `facebook_publisher_not_configured` until the remote publisher exists. No automatic trigger or historical rows were added.

### 6.2 Confirmed provider operation

Use Graph API v26.0 `POST /{page-id}/feed` with `message` and canonical article `link`. Validate and persist the successful response's exact `id`. Use `GET /{post-id}` for exact read-back. There is no supported client idempotency primitive. The present single-Page/self-admin development-mode arrangement has the review/access/mode position recorded in section 2.3; re-evaluate it before expanding to other users or Pages.

### 6.3 Established credential model

The runtime credential is the Page access token, stored only as a Cloudflare Worker secret on `media-discovery`; the User access token is not a runtime dependency. The configured Page ID is the security identity and must be validated before every public mutation. A matching ID with a different name is configuration/name drift, not a wrong credential.

The debugger's `Expires: Never` value and its separate Data Access Expiry must remain distinct. Operations must account for data-access re-authorisation, revocation, Page-task and permission changes; the credential must not be described as permanent.

### 6.4 Final remote-write and reconciliation rule

Because creation has no client idempotency primitive:

- a proven pre-dispatch failure may remain/re-enter `queued` under bounded retry rules;
- a received validated error explicitly classified as safe, such as documented rate-limit code `80001`, may return to `queued` with bounded backoff;
- input/auth/permission examples `100`, `190` and `200` must not blindly retry and should become `blocked` or another explicit non-automatic state;
- once dispatch may have occurred, any timeout, reset/drop, aborted fetch, Worker termination, response-body failure, oversized response, invalid/truncated/unparseable success response or other outcome without a confirmed post ID becomes `unknown_remote_state`;
- `unknown_remote_state` is excluded from automatic backlog selection;
- a stale `posting` row with `remote_request_started_at IS NULL` may be requeued only when all durable evidence proves no dispatch; one with a non-null marker becomes `unknown_remote_state` unless exact authoritative reconciliation proves the result;
- with an exact post ID, `GET /{post-id}` may reconcile authoritatively; without one, Page-feed similarity is operator evidence only and cannot prove identity, absence or automatic deduplication.

### 6.5 Admin idempotency rule

The same `Idempotency-Key` owns the full editorial + social intent.

For individual and bulk operations, request identity must include:

```text
article/action or canonical sorted article set
post_to_bluesky
post_to_facebook
```

Required semantics:

- same key + identical editorial/Bluesky/Facebook intent -> replay original durable result;
- same key + changed Facebook intent -> `409 idempotency_key_conflict`;
- same key + changed Bluesky intent -> existing conflict behaviour;
- omitted and explicit `false` social booleans are the same logical false intent;
- unchecked Facebook -> no Facebook publication row;
- Facebook-only requests must not be rejected by Bluesky thumbnail rules;
- Bluesky-only requests must not be rejected by Facebook availability rules;
- if both platforms are requested, all pre-commit platform eligibility must pass before the combined transition is accepted.

## 7. Phase 1: Facebook contract and D1 state — complete

The authoritative `system_docs/media/media_facebook_contract.md` and its Media README index entry are complete. Migration `0026` and the provider-independent D1/core foundation are also complete. This phase is retained as an implementation record; the contract now owns behaviour.

### 7.1 Facebook settings

Suggested logical singleton state:

```text
media_facebook_settings

id
publishing_enabled
page_id
page_name
graph_api_version
default_message_template
cooldown_seconds
last_identity_verified_at
last_successful_post_at
updated_at
```

Do not store access tokens or app secrets in D1.

Migration defaults must be safe:

```text
publishing_enabled = 0
```

Applying the migration must never publish anything.

The intended Page has now been confirmed as `UK AQ - ukaq.co.uk`, Page ID `1336337862891538`. That non-secret identity may be seeded/configured, but the Page access token must remain a Worker secret.

If settings PUT is replay-safe like Bluesky settings, add a separate `media_facebook_settings_requests` table containing only the bounded request identity/payload needed for idempotency.

Do not add an activation watermark/event ID to manual-only Facebook V1. Add one later only if automatic Facebook publication is explicitly approved.

### 7.2 Facebook publications/outbox

Suggested logical state:

```text
media_facebook_publications

id
article_id
approval_event_id
publication_key
publication_reason
status
attempt_count
facebook_post_id
facebook_permalink_url
last_error_code
next_attempt_at
remote_request_started_at
unknown_at
reconciled_at
reconciliation_method
created_at
last_attempted_at
posted_at
updated_at
```

Use explicit checked status values sufficient to represent:

```text
queued
posting
posted
failed
blocked
unknown_remote_state
```

Known-safe retryable failures should return to `queued` with bounded `last_error_code` and `next_attempt_at`. `unknown_remote_state` is a held state and must not be selected by automatic backlog processing.

Treat `facebook_permalink_url` as nullable. Persist a permalink only when an officially supported create response or exact-ID read-back supplies it; do not construct one from assumptions.

Logical publication reasons for the initial manual-only V1 can remain narrow, for example:

```text
pending_approved
rejected_repost
unhidden_repost
```

Do not create an `auto_approved` Facebook trigger until automatic Facebook posting is explicitly agreed.

Indexes should support:

- unique `publication_key`;
- oldest eligible queued job, e.g. `(status, next_attempt_at, id)`;
- article history, e.g. `(article_id, id DESC)`.

Require a valid stored `facebook_post_id` and `posted_at` when status is `posted`.

Do not add a unique `approval_event_id` constraint during manual-only V1. That belongs to a later automatic-publication design if automatic Facebook posting is approved.

Manual reposts must not be made globally unique by `article_id`. A later deliberate operator action may legitimately publish the same article again.

### 7.3 Admin request identity

Extend individual and bulk admin request state so Facebook intent is part of the durable request identity.

For the same `Idempotency-Key`:

- replaying the identical article/status/Bluesky/Facebook intent returns the original outcome;
- changing `post_to_facebook` under the same key is a conflict, not a second publication;
- changing `post_to_bluesky` under the same key remains a conflict under the existing rule.

## 8. Phase 2: shared social-publishing primitives — complete where required

Do not generalise the whole codebase prematurely, but extract small shared primitives where Bluesky and Facebook genuinely need the same behaviour.

Good candidates include only genuinely common, semantics-neutral helpers such as:

- bounded cooldown/backoff calculation where the rules are actually identical;
- error-code bounding;
- dashboard/status DTO conventions;
- common original-headline/publisher/canonical-link inputs;
- common request-idempotency validation;
- bounded generic wake-up-message validation where useful.

Do **not** share Bluesky stale-claim recovery, remote-write reconciliation or provider error classification with Facebook. Bluesky may safely requeue stale remote claims because it has deterministic remote record identity; Facebook must use the conservative ambiguous-write boundary unless Meta proves an equivalent guarantee.

Keep platform-specific pieces separate:

```text
packages/core/src/bluesky.ts
apps/media-discovery/src/bluesky.ts

packages/core/src/facebook.ts
apps/media-discovery/src/facebook.ts
```

Do not create a giant `social.ts` with provider conditionals for unrelated AT Protocol and Meta API operations.

Do not introduce a shared `SocialPublicationResult` merely for symmetry. Bluesky URI/CID and Facebook post-ID/permalink/read-back semantics are different. Introduce a common type only if later implementation demonstrates a genuinely shared boundary without weakening provider-specific validation.

## 9. Phase 3: Facebook renderer — complete

Add deterministic Facebook post rendering under the core package.

The implemented renderer accepts bounded Media fields rather than database rows or arbitrary HTML.

Conceptual input:

```text
title
publisher
canonical_url
default_message_template
```

Conceptual output:

```text
message
link
```

V1 should not add publisher Facebook mentions/tags automatically.

Facebook Page tagging behaviour and permissions are platform-specific and unnecessary for the first article-publishing path.

If publisher tagging is desired later, add explicit configured Facebook identities rather than guessing from publisher names.

## 10. Phase 4: Facebook publisher and Queue consumer — next

The next stage adds a dedicated Facebook publication module, likely:

```text
apps/media-discovery/src/facebook.ts
```

Responsibilities:

1. receive only a bounded Facebook wake-up/publication identity from Queue;
2. load settings/publication/article state from D1;
3. fail closed when publishing is disabled;
4. validate the configured Page identity before public mutation according to the final token design;
5. enforce cooldown;
6. claim one durable publication job;
7. render deterministic post content;
8. call the current Graph API with the canonical link;
9. validate the returned post identity;
10. persist posted state and remote identity;
11. classify failures into bounded retryable, permanent/blocked and ambiguous-remote-state outcomes;
12. ensure a stale `posting` claim after possible dispatch becomes `unknown_remote_state`, not automatically `queued`;
13. never select `unknown_remote_state` for automatic retry;
14. schedule the next known-safe queued job without coupling it to discovery or Bluesky.

Queue messages must not contain:

- access tokens;
- app secrets;
- article bodies;
- image bytes;
- large metadata payloads.

## 11. Phase 5: Media admin API — dormant integration complete

The existing authenticated admin mutation surfaces now carry dormant Facebook intent rather than creating a separate browser-to-Facebook publishing endpoint. They remain unable to enable or dispatch Facebook until Phase 4 is implemented.

### 11.1 Individual approval

For an operator moving an article to Approved, support:

```json
{
  "post_to_bluesky": false,
  "post_to_facebook": true
}
```

The existing article approval and the requested durable social outbox rows should be one coherent replay-safe admin operation.

Remote Facebook publication remains asynchronous.

### 11.2 Bulk approval

Add the same Facebook option to bulk approval.

The existing visible bulk Bluesky path is being repaired independently in `UK-AQ/uk-aq-ops`. That Ops repair may run in parallel with this Media implementation. Do not copy an Ops routing workaround into the Media backend.

The Media bulk API should remain the authoritative combined operation once Facebook intent is added.

Before mutating the selected set, validate all backend eligibility required by the requested combined operation.

The request must not silently ignore a checked Facebook option.

If Facebook cannot be requested because the Page publisher is unconfigured/disabled, return a clear bounded validation error before applying a combined approval + Facebook-publication request.

Bluesky's existing thumbnail eligibility remains Bluesky-specific and must not accidentally become a Facebook rule.

### 11.3 Approval failure isolation

A Facebook **remote** failure after the durable outbox has been created must not roll back an already completed article approval.

A validation failure before the combined admin transition is accepted may reject the whole requested combined operation, consistent with existing explicit-social-intent semantics.

## 12. Phase 6: dashboard in UK-AQ/uk-aq-ops

The visible Media dashboard is owned by the separate `UK-AQ/uk-aq-ops` repository.

The `uk-aq-media` repository should provide the authenticated settings/mutation/status APIs and DTOs. The visible Facebook controls/status must be implemented as a separately authorised Ops-repository task.

Add Facebook controls/status next to the existing Bluesky publication controls.

Minimum V1 surface:

- `Post to Facebook <Page name>` checkbox on individual approval;
- same checkbox on bulk approval;
- checkbox default unchecked;
- Page identity/connection status in authenticated social/settings UI;
- global Facebook publishing enabled/disabled switch;
- editable Facebook default message;
- cooldown setting if retained after Phase 0;
- recent queued/posted/failed/unknown publication state;
- link to the Facebook post when Meta returns enough identity to construct one safely;
- bounded failure code;
- explicit retry/reconcile action only where allowed by the remote-state contract.

Never show the Page access token or app secret.

The dashboard must distinguish:

```text
Media article = Approved
Facebook      = queued / retry scheduled / posting / posted / failed / blocked / unknown / not requested
Bluesky       = independent state
```

## 13. Phase 7: Cloudflare configuration and deployment

The operator-side Meta setup is already complete:

- Meta developer app created;
- Facebook Login for Business configuration created;
- required Page permissions granted;
- target Page selected and verified;
- final Page access token obtained and identity-checked.

Do not recreate the Meta app, configuration or credential during implementation unless a later credential-rotation/recovery operation requires it.

After code and migrations are structurally ready:

1. set the final Page access token as a Cloudflare Worker secret on `media-discovery` only;
2. configure the non-secret Page ID `1336337862891538`, Page name `UK AQ - ukaq.co.uk`, and the implementation's confirmed Graph API version in one authoritative configuration location;
3. set an app secret only if the final supported Meta API flow genuinely requires it;
4. create the Facebook Queue if the final design uses the proposed dedicated queue;
5. add the Queue producer/consumer bindings;
6. apply the forward-only D1 migration to TEST;
7. deploy the Media Workers to TEST;
8. leave `publishing_enabled = 0` until the deployed connection/identity operation succeeds.

No credential should be written into GitHub, Wrangler committed vars, D1, logs, dashboard HTML, browser code or Queue payloads.

## 14. Operational acceptance on TEST

Functional testing belongs here, after deployment, through real operations on the TEST system.

Do not add a speculative pre-deployment functional test suite.

### 14.1 Connection/identity operation

With publishing still disabled:

- call the bounded authenticated connection/status path;
- confirm the token resolves to Page ID `1336337862891538`;
- confirm a different Page ID fails closed;
- confirm a matching Page ID with a changed Page name is surfaced as configuration/name drift rather than misclassified as a wrong credential;
- confirm no secret is returned to the dashboard;
- confirm a missing/revoked credential fails closed.

### 14.2 First deliberate Facebook publication

Only after the operator explicitly enables Facebook publishing:

1. choose one suitable approved article deliberately;
2. request Facebook publication through the normal admin flow;
3. confirm one D1 publication row is created;
4. confirm one Queue job/wake-up path handles it;
5. confirm exactly one Facebook Page post appears;
6. confirm the post links to the canonical publisher article;
7. confirm the visible message formatting;
8. confirm the resulting link preview/card is acceptable;
9. confirm D1 records the returned Facebook post identity/status;
10. confirm the dashboard links/status match the real Page post.

Do not enable automatic Facebook publication as part of this acceptance.

### 14.3 Real failure operations

Use naturally occurring or deliberately safe TEST configuration failures, not fabricated production-like chaos tests, to validate:

- publishing-disabled behaviour;
- expired/revoked token behaviour when encountered or deliberately rotated;
- explicit API rejection;
- queue retry after a clearly pre-write/transient failure;
- operator handling of an ambiguous remote state if one occurs.

Do not intentionally create duplicate public posts merely to test deduplication.

### 14.4 Combined Bluesky + Facebook approval

Before this combined acceptance, complete one real TEST bulk **Approved + Post to Bluesky** operation through the repaired Ops dashboard path.

After the Facebook path works alone and the existing Bluesky bulk path has been operationally verified, approve one article with both social checkboxes deliberately selected.

Confirm:

- one article approval;
- one Bluesky publication request;
- one Facebook publication request;
- independent queue/publication results;
- failure of either platform does not change the other's durable result or the article's approved state.

## 15. Phase 8: automatic Facebook publishing decision

After manual Facebook publishing has completed operational acceptance, make a separate product decision on auto-approved articles.

If automatic Facebook posting is approved:

- update the Facebook contract;
- add an activation watermark or equivalent protection so enabling it cannot publish historical approvals;
- create Facebook outbox rows only for future eligible `auto_approved` events;
- keep the Facebook publishing switch independent from Bluesky;
- keep Facebook failure independent from Media approval;
- perform operational acceptance on one real new auto-approved article before leaving it enabled.

If automatic Facebook posting is not approved, leave Facebook manual-only. No automatic trigger is required merely for symmetry with Bluesky.

## 16. Observability and operator recovery

Facebook logging should use bounded identifiers only.

Useful fields:

```text
publication_id
article_id
publication_reason
attempt_count
facebook_page_id
facebook_post_id
bounded_error_code
duration_ms
```

Do not log:

- access tokens;
- app secrets;
- full API authentication headers;
- arbitrary remote response bodies without strict bounds/redaction.

The dashboard should provide enough information to distinguish:

- queued;
- retry scheduled, represented durably as queued + error + next-attempt timestamp;
- actively claimed/posting;
- posted;
- failed after known-safe retry exhaustion;
- blocked/permanent;
- unknown remote state requiring reconciliation.

An unknown remote state must be visibly different from an ordinary retryable failure and must never be silently reactivated by scheduler reconciliation.

## 17. Security boundary

The final implementation must preserve all of these:

```text
browser
  -> authenticated Media admin API
  -> D1 durable social intent
  -> Queue
  -> server-side Facebook publisher
  -> Meta Graph API
```

Never:

```text
browser -> Meta Graph API with Page token
public Worker -> Page mutation
D1 -> raw Page token
Queue -> raw Page token
logs -> raw Page token
```

The Facebook publisher should have only the bindings/secrets it needs.

## 18. Cost and operational impact

The feature should fit the existing low-volume Media architecture.

Expected additional Cloudflare usage is small:

- one D1 publication row per requested Facebook post;
- bounded D1 reads/writes per attempt;
- one small Queue message/wake-up path per job;
- one or a small number of Meta API requests per job;
- no additional AI call;
- no article-body fetch;
- no new image service in the preferred link-post design.

Meta app/permission requirements may add setup/maintenance work but should not require a new UK AQ runtime service.

Any provider pricing or account-verification requirement discovered in Phase 0 must be documented before enabling publication.

## 19. Documentation handover

Before Facebook publishing is considered established TEST behaviour:

1. create `system_docs/media/media_facebook_contract.md`;
2. add it to `system_docs/media/README.md`;
3. update Media architecture documentation where social queues/settings are listed;
4. document Cloudflare secret names without secret values;
5. document Meta app/Page identity and token-rotation procedure without credential values;
6. record the exact Graph API version used;
7. record the final remote idempotency/ambiguous-write rule;
8. record whether Facebook is manual-only or automatic for auto-approved articles;
9. update this plan's status to reflect completed phases and any superseded implementation assumptions;
10. correct any stale Bluesky README wording discovered during Stage 0, including automatic-publication semantics and the distinction between original publisher title and display title, without changing the authoritative Bluesky contract behaviour.

## 20. Implementation sequence

```text
Completed
  Meta app/Page credential setup
  Stage 0 repository structural review
  Meta Developer Assistant provider verification (20/09/2026)
  authoritative Facebook contract and README index
  migration 0026 and pure deterministic core foundation
  dormant individual/bulk admin integration and bounded DTO state

Next implementation stage
  server-side Graph API provider in media-discovery
  dedicated uk-aq-media-facebook Queue producer/consumer bindings
  durable remote_request_started_at dispatch boundary
  conservative error classification and unknown_remote_state handling
  publishing remains disabled

Parallel Ops Facebook workstream
  Facebook checkbox/settings/status/reconciliation UI
  in UK-AQ/uk-aq-ops

Then
  Cloudflare TEST Queue/bindings/secret/deployment
  publishing disabled initially
  deployed identity check and TEST operational acceptance
  one deliberate Facebook-only publication
  one combined Bluesky + Facebook approval after bulk Bluesky verification

Deferred
  separate product/contract decision on automatic Facebook publishing
```

Facebook must remain disabled until the server-side stage and TEST acceptance are complete. The first implementation remains manual-only.

## 21. Definition of done for initial V1

Initial Facebook V1 is complete when:

- the already-verified target Facebook Page ID `1336337862891538` is explicitly configured and revalidated by the runtime before public mutation, with Page-name changes surfaced as configuration drift rather than treated as a different identity;
- the Page access token exists only as a Cloudflare secret in the deployed runtime;
- Facebook publishing is disabled by default after migration/deployment;
- operator approval surfaces can independently request Bluesky and/or Facebook;
- manual Facebook intent is replay-safe;
- one durable Facebook publication row owns each request;
- the publisher posts the canonical article link through the supported Meta Page API;
- remote Facebook state is recorded without duplicate-prone blind retries;
- ambiguous remote writes have an explicit safe state/reconciliation path;
- Facebook failure cannot fail article approval, Bluesky, discovery, public Media or the UK AQ website;
- Page/post status is visible in the authenticated Ops dashboard;
- the existing bulk Approved + Post to Bluesky path has completed one real TEST operation successfully before combined social acceptance;
- the first deliberate real Facebook Page post has completed operational acceptance on TEST;
- no automatic Facebook approval-event trigger exists unless separately agreed;
- the accepted behaviour has been promoted into the Facebook system-doc contract.
