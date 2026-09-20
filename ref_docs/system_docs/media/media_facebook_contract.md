# UK AQ Media Facebook publication contract

**Status:** Authoritative future implementation contract; provider-independent foundation and dormant admin integration are implemented, but remote publishing is disabled pending the server-side provider/Queue stage and TEST operational acceptance.  
**Provider verification:** Meta Developer Assistant-confirmed on 20/09/2026 for Graph API v26.0; this record does not claim that Codex independently fetched Meta's linked reference pages.

## 1. Authority and scope

This contract is the narrow authority for UK AQ Media publication to the Facebook Page identified below. It governs the implemented dormant foundation and the agreed manual-only V1 remote publisher. It does not assert that the Queue, Worker secret, Meta HTTP publisher or public posting path is deployed.

The broad Media boundaries remain in [`media_contract.md`](media_contract.md), and editorial publication policy remains in [`media-publication-policy-contract.md`](media-publication-policy-contract.md). [`media_bluesky_contract.md`](media_bluesky_contract.md) continues to own Bluesky behaviour. Facebook MUST remain independent and MUST NOT inherit provider-specific Bluesky retry or thumbnail rules.

Runtime implementation belongs in `UK-AQ/uk-aq-media`; visible dashboard work belongs in `UK-AQ/uk-aq-ops`. This contract does not authorise deployment or external-system mutation.

## 2. Target Page identity

The single V1 destination is:

```text
Page ID:   1336337862891538
Page name: UK AQ - ukaq.co.uk
```

The Page ID is the stable security identity. The Page name is presentation/configuration metadata and may change.

Before every public Facebook mutation, the server-side runtime MUST resolve the Page-token identity using the supported Meta identity operation and compare the resolved ID with the configured Page ID. A mismatch MUST fail closed before the mutation. If the ID matches but the display name differs, the runtime MUST surface and log bounded configuration/name drift; it MUST NOT reject the credential solely because the name changed.

## 3. Credential and lifecycle boundary

The runtime credential is the final Facebook **Page access token**. The User access token used during setup is not a runtime dependency. The Page token MUST exist only as a Cloudflare Worker secret on `media-discovery` and MUST NOT appear in Git, D1, Queue messages, browser code, admin responses, logs or documentation. An app secret may be added only if the supported implementation genuinely requires it and MUST have the same secret boundary.

Manual setup verification established that `GET /me?fields=id,name` resolved the Page token to the configured Page ID and setup-time name. The Access Token Debugger showed token type `Page`, validity `true`, and `Expires: Never`; it also showed a **Data Access Expiry**. `Expires: Never` describes observed token-expiry metadata only. It does not mean permanently unattended access and does not remove data-access expiry, revocation, permission, Page-task, app-mode or re-authorisation risks.

Operations MUST monitor and handle both credential validity and data-access lifecycle. Missing, revoked, expired, re-authorisation-required or wrongly scoped credentials MUST fail closed, expose only a bounded error, and follow the non-automatic retry classification in section 10.

## 4. Manual-only V1 eligibility and independent intent

Facebook V1 is manual-only. An authenticated operator MAY request Facebook publication while explicitly transitioning an article to Approved. Individual and bulk approval use independent booleans:

```text
post_to_bluesky
post_to_facebook
```

The Facebook control defaults unchecked. False or omitted Facebook intent creates no Facebook publication row. Facebook eligibility is independent from Bluesky thumbnail eligibility; a Facebook-only request MUST NOT require a Bluesky thumbnail.

There is no historic scan or backfill and no Facebook trigger for auto-approved articles. Enabling automatic publication later requires a separate product decision, an authoritative contract update, protection against historical publication, implementation and TEST acceptance.

All eligibility needed for a combined approval/social request MUST be checked before committing that transition. A pre-commit eligibility failure MAY reject the combined request without changing article state. After durable approval and publication intent are accepted, remote social outcomes are isolated as described in section 13.

## 5. Deterministic post content

The V1 message is rendered deterministically from Media metadata:

```text
{original publisher headline}
From {publisher}

Live and historical UK air quality data:
https://ukaq.co.uk/
```

The canonical publisher article URL is supplied separately as Facebook's `link` parameter.

The publisher headline MUST be the stored original publisher headline, not a pending AI title. Facebook rendering MUST NOT invoke AI, fetch article-body content, require a Bluesky thumbnail, upload an image merely for symmetry, or guess publisher Facebook account/tag identities.

## 6. Durable intent and idempotency

D1 is authoritative for local intent and publication state. Individual and bulk admin request identities include the full editorial action and both social booleans. Replaying the same `Idempotency-Key` with identical intent returns the original result; changing either social intent under that key is a conflict. The approval transition and requested social publication rows are created transactionally.

`media_facebook_publications.publication_key` provides local durable idempotency. It prevents duplicate local outbox creation for one request; it does **not** imply remote idempotency. Deliberate later reposts remain possible and MUST NOT be prohibited by global article-ID uniqueness.

The durable Facebook statuses are:

```text
queued
posting
posted
failed
blocked
unknown_remote_state
```

Known-safe retry scheduling is represented by `status = queued`, a bounded `last_error_code`, and a future `next_attempt_at`. A dashboard may label that state **Retry scheduled**. `unknown_remote_state` is held and excluded from automatic backlog selection.

`posted` requires both `facebook_post_id` and `posted_at`. `facebook_permalink_url` remains nullable. The implementation MUST NOT manufacture a permalink from an assumed URL pattern.

## 7. Queue and runtime boundary

The intended dedicated Queue is `uk-aq-media-facebook`. After a durable Facebook publication row exists, `media-admin` produces a generic wake-up. The existing `media-discovery` Worker consumes wake-ups, owns the Page-token secret and performs the server-side provider operation.

Payloads contain only bounded wake-up identity, for example:

```json
{ "type": "facebook_wakeup" }
```

They MAY include a bounded `publication_id` where useful. They MUST NOT contain credentials, article bodies, image data or large provider payloads. D1 state, not the Queue message, owns work truth.

## 8. Provider API contract

The following facts are **Meta Developer Assistant-confirmed on 20/09/2026** for Graph API v26.0. This wording records the supplied provider verification and does not claim independent retrieval of linked Meta reference pages.

- Create a Page link post with `POST /{page-id}/feed`, supplying `message`, `link` and the Page access token.
- A successful creation response contains JSON field `id`, representing the created Page post. The exact returned ID MUST be validated and persisted as `facebook_post_id`.
- An exact created post can be read with `GET /{post-id}`. The Page feed can be read with `GET /{page-id}/feed`.
- Page feed creation provides no supported client-supplied idempotency key/token equivalent.
- For the present app used solely by its own developer/admin to publish to the one Page they manage, with the appropriate Page task, App Review, Advanced Access, Business Verification and Live-mode activation are not required for this self-admin development-mode use. This conclusion MUST NOT be generalised to third-party Pages or other users.
- Supplied error examples were `80001` for Page-account rate limiting/too many calls, `100` for invalid parameter, `190` for invalid OAuth token and `200` for permissions error. These examples do not establish retry safety for arbitrary Graph API errors.

If supported create/read-back behaviour supplies an authoritative permalink field, the runtime MAY persist it. It MUST prefer a returned or exact read-back permalink field where officially supported and MUST NOT derive one from an assumed pattern.

## 9. Remote dispatch boundary

Because Meta exposes no client-controlled idempotency primitive for this creation operation, the runtime MUST durably record a dispatch boundary such as `remote_request_started_at` immediately before the request may be dispatched.

- A failure is **definite pre-dispatch** only when the implementation can prove no Page-post request was dispatched. It may remain or re-enter `queued` under bounded retry rules.
- A received and validated provider response may be retried only when the implemented provider contract explicitly classifies it as known-safe, such as the Meta Developer Assistant-confirmed rate-limit case `80001`. It returns to `queued` with bounded backoff.
- Auth, permission and input failures such as `190`, `200` and `100` MUST NOT blindly retry. They become `blocked` or another explicit non-automatic-retry state with a bounded code.

No implementation may infer retry safety merely from an HTTP status, a generic Graph error, transport library behaviour or these example codes.

## 10. Ambiguous writes and retry classification

Once a Page-post request may have been dispatched, any outcome without a confirmed created-post ID is ambiguous. This includes network timeout, connection reset/drop, aborted fetch, Worker termination/crash after dispatch, response-body failure, response too large, an invalid/truncated/unparseable success response, and any other condition in which UK AQ cannot prove whether Meta accepted the write.

The row MUST become `unknown_remote_state` and MUST NOT retry automatically. This conservative rule overrides any suggestion that a connection failure is automatically safe merely because no response was received.

Bounded attempt limits and backoff apply only to definite pre-dispatch or explicitly classified known-safe failures. Exhausted known-safe retries may become `failed`; configuration, auth, permission or input faults should normally become `blocked`. Error storage and display MUST use bounded codes rather than raw response bodies.

## 11. Stale claims

Facebook MUST NOT copy Bluesky's general stale-`posting` to `queued` recovery.

- A stale `posting` row with `remote_request_started_at IS NULL` MAY be recovered/requeued only when all other durable state proves no remote dispatch occurred.
- A stale `posting` row with `remote_request_started_at IS NOT NULL` MUST become `unknown_remote_state`, unless an exact authoritative reconciliation mechanism proves the outcome.

Scheduler/backlog reconciliation MUST exclude `unknown_remote_state` and MUST NOT silently clear the dispatch marker.

## 12. Reconciliation

When an exact validated Facebook post ID is available, `GET /{post-id}` MAY provide authoritative read-back/reconciliation. Reconciliation outcomes and method MUST be recorded durably without overwriting audit history.

Without an exact post ID, an operator MAY inspect `GET /{page-id}/feed` for similar message/link/time as evidence. Similarity MUST NOT automatically prove that a matching post belongs to this publication or that no post was created. Text, link and time MUST NOT be used as an automatic deduplication key.

An unresolved `unknown_remote_state` remains held for explicit operator reconciliation unless Meta later supplies a stronger authoritative mechanism. Any explicit operator decision to post again must make duplicate risk clear and be separately authorised/audited; it is never an automatic retry.

## 13. Failure isolation

After durable article approval and Facebook intent are accepted, a Facebook Queue, provider, credential or reconciliation failure MUST NOT roll back or fail:

- article approval;
- Bluesky publication or state;
- discovery;
- public Media; or
- the UK AQ website.

Facebook and Bluesky publication results remain independent even when requested in one admin operation.

## 14. Dashboard and operator state

Authenticated article list/detail DTOs expose only bounded Facebook state. The dashboard must distinguish `not requested`, `queued`, `retry scheduled`, `posting`, `posted`, `failed`, `blocked` and `unknown remote state`, independently of article and Bluesky state.

It should show the configured Page identity, connection/name-drift status, attempt timing, bounded error code and a post link only when an authoritative permalink exists. It MUST never expose tokens, authentication headers or unbounded provider responses. `unknown remote state` must be visibly held and any reconciliation/repost action must communicate duplicate risk.

## 15. Security and logging

The only permitted mutation path is:

```text
authenticated operator
  -> Media admin API
  -> D1 durable intent
  -> dedicated Queue wake-up
  -> media-discovery server-side publisher
  -> Meta Graph API
```

The public Worker and browser MUST NOT mutate Facebook. Logs may contain bounded local IDs, configured Page ID, validated post ID, reason, attempt, bounded error code and duration. They MUST NOT contain tokens, secrets, authentication headers, article bodies or unbounded/raw provider response bodies.

## 16. Operational acceptance and enablement

Facebook remains disabled until the server-side provider and Queue runtime is implemented, deployed to TEST and accepted. At minimum, TEST acceptance MUST demonstrate:

1. disabled-by-default and missing/revoked-credential fail-closed behaviour;
2. Page-token identity match, Page-ID mismatch rejection before mutation, and name-only drift handling;
3. one deliberate manual Facebook-only publication with exactly one durable row and one Page post;
4. exact returned post-ID persistence and exact-ID read-back, with nullable permalink handling;
5. canonical link and deterministic message rendering;
6. bounded known-safe retry scheduling and non-retry treatment for auth/permission/input errors;
7. dispatch-boundary persistence, stale-claim classification and `unknown_remote_state` exclusion from automatic selection;
8. secret absence from Git, D1, Queue payloads, browser/admin output and logs;
9. independent combined Bluesky/Facebook behaviour after the existing bulk Bluesky path has passed real TEST operation; and
10. dashboard visibility and explicit operator handling for blocked/unknown outcomes.

Acceptance MUST NOT intentionally create duplicate public posts merely to test ambiguity. Publishing remains manual-only after acceptance unless the separate automatic-publication decision and contract change occur.
