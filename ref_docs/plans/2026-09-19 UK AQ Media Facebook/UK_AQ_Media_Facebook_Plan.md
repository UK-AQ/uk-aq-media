# UK AQ Media Facebook Page publishing implementation plan

**Date:** 19 September 2026  
**Updated:** 20 September 2026  
**Status:** Draft implementation plan; Meta/Page credential setup complete; Facebook publishing not yet implemented  
**Implementation repository:** private `UK-AQ/uk-aq-media`  
**System-docs repository:** `TEST-uk-aq/uk-aq-system-docs`  
**Runtime owner:** UK AQ Media Cloudflare account  
**Target:** Facebook Page `UK AQ - ukaq.co.uk`, Page ID `1336337862891538`  
**Related authority:** [`../../system_docs/media/media_contract.md`](../../system_docs/media/media_contract.md), [`../../system_docs/media/media_bluesky_contract.md`](../../system_docs/media/media_bluesky_contract.md)

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

This plan is non-authoritative. Before Facebook publishing is enabled beyond initial TEST acceptance, the agreed load-bearing Facebook behaviour should be promoted into a dedicated contract under `system_docs/media/`. Existing Media and Bluesky contracts continue to own their current areas.

## 2. Current implementation and Meta setup facts checked 20/09/2026

The implementation repository is now `UK-AQ/uk-aq-media`. The former `TEST-uk-aq/uk-aq-media` GitHub URL redirects to that repository. TEST operational acceptance still happens before Facebook publishing is treated as established behaviour.

The current Media implementation already contains a mature Bluesky publishing path that can be used as the reference architecture.

Relevant current files include:

```text
apps/media-discovery/src/bluesky.ts
packages/core/src/bluesky.ts
migrations/0021_bluesky_publications.sql
migrations/0025_manual_bluesky_approval.sql
docs/system-docs-reference/media_bluesky_contract.md
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
- Meta's Access Token Debugger reported the final credential as a valid `Page` token with `Expires: Never`;
- using that Page token, `/me?fields=id,name` resolved to Page ID `1336337862891538` and name `UK AQ - ukaq.co.uk`.

The Page token remains revocable/invalidatable by Meta or by later account/Page/app changes even though the debugger shows no fixed expiry. Runtime code therefore still needs fail-closed identity validation and a documented credential-rotation/recovery procedure.

The runtime credential is the final **Page access token**. The User access token is not required by the Media runtime.

No token value, User token, app secret or other credential may be committed to GitHub, copied into D1, included in Queue messages, returned to browser code, logged, or added to documentation.


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

The runtime must still fail closed before public mutation if the configured credential resolves to a different Page identity.

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

The preferred Facebook V1 is a normal Page link post where Meta builds the article preview from the canonical publisher URL.

Conceptually:

```text
POST /{page-id}/feed

message = rendered UK AQ Facebook text
link    = canonical publisher article URL
```

Do not initially copy the Bluesky thumbnail-fetch -> uploadBlob -> explicit external-card pipeline into Facebook.

That simplification is conditional on the targeted Phase 0 API check confirming the current Pages API still supports the intended link-post shape and that the result is acceptable for the Page.

Facebook link-preview image availability should initially be treated as platform/publisher metadata behaviour rather than as a new UK AQ image-fetch entitlement.

Do not broaden Media's image permissions merely to force a Facebook thumbnail.

If Meta's current API requires a materially different supported posting shape, stop and update this plan/contract before implementing an unrelated image-upload workaround.

## 6. Phase 0: remaining targeted structural viability checks

These are the only pre-implementation checks required. They determine whether the proposed code, configuration and migrations are structurally viable. They are not a speculative functional test suite.

The operator-side Meta app, permission, Page identity and Page-token acquisition work described in section 2.1 is already complete. Phase 0 must not repeat that setup.

### 6.1 Current Meta Pages publishing API

Using current official Meta documentation, confirm the remaining provider details immediately before implementation:

1. the current Graph API endpoint and supported fields for publishing a normal link post to a Facebook Page, expected to be the current equivalent of `POST /{page-id}/feed` with `message` and canonical article `link`;
2. whether App Review, Business Verification, Live mode or another Meta approval step is required for this exact single-Page unattended server-side automation, despite the operator-side permission flow already succeeding;
3. that Graph API `v26.0` remains current/supported for the implementation and record its deprecation horizon;
4. current request/rate restrictions relevant to a low-volume Page publisher;
5. the exact returned published-post identity shape and the supported way to read back enough state to present/reconcile a post;
6. whether Meta provides a supported client-supplied idempotency/request key for Page feed publication.

The following no longer need to be rediscovered unless Meta's current documentation contradicts the completed setup:

- the target Page ID/name;
- the three granted Page permissions;
- the basic User-token -> Page-token acquisition flow;
- the fact that the final Page token resolves to the UK AQ Page.

Do not code against remembered Meta fields or an old Graph API version without this check.

Useful current Meta documentation entry points include:

- <https://developers.facebook.com/documentation/pages-api/manage-pages>
- <https://developers.facebook.com/docs/facebook-login/guides/access-tokens/>
- <https://developers.facebook.com/docs/permissions/>

Provider rules are changeable, so implementation must still re-check the API surface even though credential setup is complete.

### 6.2 Established credential model and remaining implementation decisions

The credential model is now established:

- runtime credential type: Facebook **Page access token**;
- target Page ID: `1336337862891538`;
- target Page name: `UK AQ - ukaq.co.uk`;
- token identity: manually verified against the Page;
- token debugger status at setup: valid Page token, `Expires: Never`;
- storage boundary: Cloudflare Worker secret only;
- the long-lived User token is not a runtime dependency.

Before implementation, confirm only the remaining structural details:

- the Cloudflare secret name;
- the exact fail-closed Page-identity validation call used before public mutation;
- how revoked/invalid credentials are classified and surfaced;
- the deliberate token replacement/rotation procedure;
- whether an app secret is actually required by the final supported server-side flow. Do not add one merely for symmetry.

Do not store a personal Facebook password, interactive login cookie, User access token or Page access token anywhere outside the approved secret-management boundary.

### 6.3 Remote-write idempotency and ambiguous failures

This remains a load-bearing check.

Bluesky uses a deterministic AT Protocol record key so a retry can address the same remote record. A Facebook `/{page-id}/feed` POST may not offer the same primitive.

Confirm whether the current Graph API supports a client-supplied idempotency mechanism.

If it does, use it.

If it does not, the implementation must explicitly handle the remote-write/D1 crash window.

The safe default is:

- explicit pre-request failures can retry;
- explicit API rejections can follow bounded retry rules where the status is clearly transient;
- a timeout/connection loss after the request may have reached Meta is an **ambiguous remote state**;
- ambiguous remote state must not blindly auto-retry and risk duplicate public posts;
- instead record a bounded `unknown_remote_state`/equivalent status for operator reconciliation unless a reliable read-back reconciliation key can be designed.

Do not weaken this boundary merely to make retry logic look symmetrical with Bluesky.

### 6.4 Existing Queue consumer shape

Confirm the current Media Worker/Queue configuration can add a dedicated Facebook queue, for example:

```text
uk-aq-media-facebook
```

while preserving existing discovery and Bluesky queue consumers.

Prefer to keep the current Media Worker topology and dispatch by queue identity/message type if the current Wrangler configuration supports it cleanly.

Do not create a fourth/fifth Worker unless the current runtime gives a concrete reason.

### 6.5 Current admin idempotency schema

Inspect the current applied migrations and admin mutation code before selecting migration numbers.

The current social intent is Bluesky-specific, for example:

```text
media_admin_status_requests.post_to_bluesky
media_admin_bulk_status_requests.post_to_bluesky
```

Confirm the structurally safest forward-only extension so the same replay identity also owns Facebook intent.

Likely logical state:

```text
post_to_bluesky
post_to_facebook
```

The idempotency record must distinguish a replay of the same request from a different social-intent request.

Do not rewrite applied migrations.

## 7. Phase 1: Facebook contract and D1 state

Once Phase 0 confirms the Meta API shape, create the dedicated authoritative contract:

```text
system_docs/media/media_facebook_contract.md
```

and add it to the Media documentation index.

The contract should fix the final account, eligibility, manual-publication, message, failure-isolation, secret, retry and operational rules before Facebook is enabled.

Then add a forward-only Media migration.

### 7.1 Facebook settings

Suggested logical singleton state:

```text
media_facebook_settings

id
publishing_enabled
page_id
page_name
default_message_template
cooldown_seconds
last_successful_post_at
last_successful_api_contact_at
updated_at
```

Do not store access tokens or app secrets in D1.

Migration defaults must be safe:

```text
publishing_enabled = 0
```

Applying the migration must never publish anything.

The intended Page has now been confirmed as `UK AQ - ukaq.co.uk`, Page ID `1336337862891538`. That non-secret identity may be seeded/configured, but the Page access token must remain a Worker secret.

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
created_at
last_attempted_at
posted_at
updated_at
```

Allow status values needed by the final remote-write design, including an explicit ambiguous/unknown state if Meta has no safe remote idempotency primitive.

Logical publication reasons for the initial manual-only V1 can remain narrow, for example:

```text
pending_approved
rejected_repost
unhidden_repost
```

Do not create an `auto_approved` Facebook trigger until automatic Facebook posting is explicitly agreed.

Indexes should support:

- publication lookup by article;
- oldest eligible queued job;
- request/publication-key uniqueness;
- bounded operator history.

Manual reposts must not be made globally unique by `article_id`. A later deliberate operator action may legitimately publish the same article again.

### 7.3 Admin request identity

Extend individual and bulk admin request state so Facebook intent is part of the durable request identity.

For the same `Idempotency-Key`:

- replaying the identical article/status/Bluesky/Facebook intent returns the original outcome;
- changing `post_to_facebook` under the same key is a conflict, not a second publication;
- changing `post_to_bluesky` under the same key remains a conflict under the existing rule.

## 8. Phase 2: shared social-publishing primitives

Do not generalise the whole codebase prematurely, but extract small shared primitives where Bluesky and Facebook genuinely need the same behaviour.

Good candidates include:

- publication job claiming;
- bounded cooldown scheduling;
- D1 status transitions;
- error-code bounding;
- dashboard status DTOs;
- common original-headline/publisher inputs;
- common request-idempotency validation.

Keep platform-specific pieces separate:

```text
packages/core/src/bluesky.ts
apps/media-discovery/src/bluesky.ts

packages/core/src/facebook.ts
apps/media-discovery/src/facebook.ts
```

Do not create a giant `social.ts` with provider conditionals for unrelated AT Protocol and Meta API operations.

A small shared type such as:

```ts
type SocialPublicationResult = {
  platform: 'bluesky' | 'facebook';
  remoteId: string;
  url?: string;
  postedAt: string;
};
```

may be appropriate if it genuinely simplifies dashboard/status plumbing, but platform database tables remain independent.

## 9. Phase 3: Facebook renderer

Add deterministic Facebook post rendering under the core package.

The renderer should accept bounded Media fields rather than database rows or arbitrary HTML.

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

## 10. Phase 4: Facebook publisher and Queue consumer

Add a dedicated Facebook publication module, likely:

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
12. schedule the next queued job without coupling it to discovery or Bluesky.

Queue messages must not contain:

- access tokens;
- app secrets;
- article bodies;
- image bytes;
- large metadata payloads.

## 11. Phase 5: Media admin API

Extend existing authenticated admin mutation surfaces rather than creating a separate browser-to-Facebook publishing endpoint.

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

Before mutating the selected set, validate all backend eligibility required by the requested combined operation.

The request must not silently ignore a checked Facebook option.

If Facebook cannot be requested because the Page publisher is unconfigured/disabled, return a clear bounded validation error before applying a combined approval + Facebook-publication request.

Bluesky's existing thumbnail eligibility remains Bluesky-specific and must not accidentally become a Facebook rule.

### 11.3 Approval failure isolation

A Facebook **remote** failure after the durable outbox has been created must not roll back an already completed article approval.

A validation failure before the combined admin transition is accepted may reject the whole requested combined operation, consistent with existing explicit-social-intent semantics.

## 12. Phase 6: dashboard

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
Facebook      = queued / posted / failed / unknown / not requested
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

1. set the final Page access token as a Cloudflare Worker secret;
2. configure the non-secret Page ID `1336337862891538`, Page name `UK AQ - ukaq.co.uk`, and the implementation's confirmed Graph API version;
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
- confirm the token resolves to the expected Page ID/name;
- confirm no secret is returned to the dashboard;
- confirm a wrong/missing credential fails closed.

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

After the Facebook path works alone, approve one article with both social checkboxes deliberately selected.

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
- actively claimed/posting;
- posted;
- clearly failed/retryable;
- blocked/permanent;
- unknown remote state requiring reconciliation.

An unknown remote state must be visibly different from an ordinary retryable failure.

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
9. update this plan's status to reflect completed phases and any superseded implementation assumptions.

## 20. Implementation sequence

Recommended order:

```text
Phase 0
  remaining Meta API + idempotency structural checks
  current Queue/admin/migration structural checks
  Meta credential setup already complete

Phase 1
  agree/promote Facebook contract
  forward-only D1 settings/publication/admin-intent migration

Phase 2
  narrow shared social primitives where justified

Phase 3
  deterministic Facebook renderer

Phase 4
  server-side Facebook publisher + Queue

Phase 5
  authenticated admin mutation integration

Phase 6
  dashboard checkbox/settings/status

Phase 7
  Cloudflare TEST configuration and deployment
  use the already-verified UK AQ Page credential

Operational acceptance
  real manual Page publication on TEST

Phase 8
  separate decision on automatic auto-approved Facebook publishing

Documentation handover
  make accepted behaviour authoritative
```

The first implementation should stop after manual publication is operating reliably unless automatic Facebook posting is explicitly approved.

## 21. Definition of done for initial V1

Initial Facebook V1 is complete when:

- the already-verified target Facebook Page identity (`UK AQ - ukaq.co.uk`, Page ID `1336337862891538`) is explicitly configured and revalidated by the runtime before public mutation;
- the Page access token exists only as a Cloudflare secret in the deployed runtime;
- Facebook publishing is disabled by default after migration/deployment;
- operator approval surfaces can independently request Bluesky and/or Facebook;
- manual Facebook intent is replay-safe;
- one durable Facebook publication row owns each request;
- the publisher posts the canonical article link through the supported Meta Page API;
- remote Facebook state is recorded without duplicate-prone blind retries;
- ambiguous remote writes have an explicit safe state/reconciliation path;
- Facebook failure cannot fail article approval, Bluesky, discovery, public Media or the UK AQ website;
- Page/post status is visible in the authenticated dashboard;
- the first deliberate real Page post has completed operational acceptance on TEST;
- no automatic Facebook approval-event trigger exists unless separately agreed;
- the accepted behaviour has been promoted into the Facebook system-doc contract.
