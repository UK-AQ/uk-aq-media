# Threads Stage 1 handover — 2 November 2026

This implements the manual-only backend in `TEST-uk-aq/uk-aq-media` under the
approved [Threads contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/media/media_threads_contract.md).
It has not been deployed or exercised against a Threads account. System docs,
Ops/browser UI and LIVE were not modified. The operator owns deployment and the
subsequent complete-file LIVE promotion and real publishing acceptance.

## Behaviour and boundaries

- Optional `post_to_threads` is supported on single Pending/Rejected approval,
  Hidden unhide, bulk approval, and single/bulk direct publication of Approved
  articles. Omitted and false mean no Threads intent. All three social booleans
  belong to each durable request identity and its transactional guards.
- Threads-only requests create no Facebook or Bluesky jobs. Ordinary approval
  without Threads remains available when Threads is unconfigured. Once committed,
  provider and Queue failures do not roll back approval or other social jobs.
- Threads uses stored `media_articles.title`, publisher attribution and the
  unchanged canonical publisher `link_attachment`. No AI, display headline,
  publisher-body request, image request or image upload is used.
- Text is capped conservatively at 500 UTF-8 bytes. Only the headline is shortened,
  at grapheme boundaries; attribution and URL are never truncated.
- Each intent snapshots the expected Threads user ID. A later identity change
  blocks old work rather than silently posting it to another account.
- A dedicated Queue contains only wake-up/check/reconciliation identifiers.
  D1 owns ordering, claims, cooldown, attempts, provider IDs and results.
- Manual publishing defaults disabled. `automatic_publishing_enabled` is fixed
  at zero by a database CHECK; the API rejects that field. Publication reasons
  exclude `auto_approved`. There is no Threads approval trigger, historical scan,
  rediscovery producer or backfill. Scheduler reconciliation only wakes existing
  manual rows.

## Provider sequence and safety

The discovery Worker uses `https://graph.threads.net/v1.0`. Before a container or
publish mutation it verifies `/me?fields=id,username` against both configured
values, checks live publishing quota, then rechecks the manual gate, article
Approved status, cooldown, claim and target account at the D1 dispatch boundary.
All provider requests have a 15-second timeout, bounded 16 KiB JSON responses and
manual redirect handling. Credentials travel in the Authorization header.

Container creation uses `media_type=TEXT`, `text`, `link_attachment` and
`auto_publish_text=false`. The returned container ID is persisted. A subsequent
Queue wake checks `id,status` after at least a minute; `IN_PROGRESS` is polled at
one-minute intervals with a five-check bound. Only `FINISHED` proceeds to the
separate `/{user-id}/threads_publish` call with `creation_id`. Containers are
never treated as published posts. Expired, erroneous or unrecognised container
states fail visibly. No fallback destination or thumbnail-less alternative is
substituted.

The publish-dispatch marker is durable before the publish call. A valid returned
post ID is persisted before final status and optional exact read-back. A missing
ID, malformed/oversized response, timeout, transport error or unclassified publish
rejection becomes `unknown_remote_state`. There is no automatic publish retry.
Complete auth/permission/input rejection codes 190/200/10/100 become blocked.
Pre-publish safe failures, including quota exhaustion, use at most five attempts
with exponential delay bounded at 12 hours. Container polling has its own bound.

Stale claims before the publish marker may requeue; stale claims after it are
held. Claim keys prevent an old consumer from acting under a replacement claim.
Unknown outcomes hold the Threads dispatcher globally until explicit resolution.
Confirmed post IDs, nullable provider-returned permalinks and dispatch evidence
survive holds. No permalink is constructed from an ID or username.

Disabling manual publishing preserves queued work; re-enabling can resume it.
Queued cancellation becomes `blocked/operator_cancelled` and is never reactivated
by re-enabling. Article status changes do not delete publication history.

## Authenticated administrative API

These routes use the existing Media bearer authentication and no-store responses.
Use a fresh 16–100 character `Idempotency-Key` for each deliberate mutation;
replay an identical action using the same key.

| Route | Method and body | Result |
|---|---|---|
| `/admin/threads/settings` | GET | Manual availability/reason, manual gate, automatic=false, expected identity, bounded connection/error state, operator-reported expiry, global unknown hold count, cooldown |
| `/admin/threads/settings` | PUT `{"manual_publishing_enabled":false,"cooldown_minutes":10}` | Idempotent manual gate/cooldown update; enable requires a successful account check |
| `/admin/threads/connection-check` | POST `{}` | Queues a read-only identity check; read settings for its result |
| `/admin/threads/publications` | GET; optional `article_id`, `before_id`, `limit` (max 50) | Independent bounded publication history with returned IDs, nullable permalink, attempts, timestamps and errors |
| `/admin/threads/publications/{id}/cancel` | POST `{}` | Cancels queued work with no publish-dispatch marker |
| `/admin/threads/publications/{id}/reconcile` | POST `{"threads_post_id":"<exact-id>","confirm_exact_publication":true}` | Queues exact-ID read-back for held/posted work, validates the configured profile and returned post username; never posts |
| `/admin/threads/publications/{id}/confirm-not-posted` | POST `{"confirm_not_posted":true,"acknowledge_duplicate_risk":true}` | Audits the operator's external investigation and releases an unknown hold as blocked; never requeues it |

For unresolved ambiguity, inspect the real account before using either resolution
route. Similar text/link/time is not automatic proof. `confirm-not-posted` is an
explicit human attestation, not provider-confirmed absence. Only a new deliberately
authorised request/key can create a later post. Repeat a lost reconciliation
wake-up using the same request/key. A post read-back must succeed before a held
row can become posted through reconciliation.

Existing `/admin/articles/{id}` GET includes a separate `threads` object with
history and manual/direct eligibility. Article list rows include Threads counts,
latest status and bounded error. Mutation receipts include independent
`threads_publication` or `threads_publications`; clients should refetch article
detail after mutations, as for other editorial state.

Use `post_to_threads:true` with the existing:

- `POST /admin/articles/{id}/approve` or `/unhide`;
- `POST /admin/articles/bulk/approve` with `article_ids` (maximum 50);
- `POST /admin/articles/{id}/publish`;
- `POST /admin/articles/bulk/publish` with `article_ids` (maximum 50).

The latter two require at least one of `post_to_bluesky`, `post_to_facebook`,
`post_to_threads` to be true. Plain approval permits all false. Strict schemas
reject an All/None API flag. The Ops dashboard follow-up must add three independent
unchecked platform controls plus the contracted UI-only All/None master, forward
the three booleans through its existing protected proxy, expose the routes above,
and display disabled/unavailable reasons. No Ops UI is included in this PR.

## Migration and deployment configuration

Apply forward migration `0056_threads_manual_publications.sql` before the updated
Admin/Discovery Workers. It adds Threads selection to status/bulk identities and
rebuilds the direct request CHECK to permit Threads-only requests, retaining old
rows with Threads=false. It creates independent settings, publications and
operator-request audit tables. It does not change Facebook/Bluesky tables,
existing triggers or publication history, and creates no publication jobs.

The existing core workflow now provisions `uk-aq-media-threads`, applies outstanding
migrations, and deploys the usual Workers. Both Admin and Discovery need the
`MEDIA_THREADS_QUEUE` producer; Discovery also needs its single-concurrency
consumer. Missing Threads credentials are not a deployment prerequisite.

The same names and templates apply in each independently configured environment:

| External setting | Store/use |
|---|---|
| `UK_AQ_MEDIA_THREADS_TOKEN` | Optional GitHub Actions secret, securely delivered to the Discovery Worker secret of the same name; never Admin, D1, browser, Queue or source |
| `UK_AQ_MEDIA_THREADS_USER_ID` | Optional GitHub variable; expected Threads user ID, never Facebook Page ID |
| `UK_AQ_MEDIA_THREADS_USERNAME` | Optional GitHub variable; exact expected username without `@` |
| `UK_AQ_MEDIA_THREADS_TOKEN_EXPIRES_AT` | Optional GitHub variable; actual provider expiry as a UTC ISO timestamp ending `Z`; expired/invalid values block dispatch |

The renderer derives the non-secret `UK_AQ_MEDIA_THREADS_CONFIGURED` flag solely
from optional deployment-token presence and supplies the identity/expiry vars to
Admin and Discovery. It never serializes the token into configuration. Committed
templates default false/empty and have no account-specific defaults. A false flag
blocks dispatch even if an older Worker secret remains installed. A true flag is
not proof that the actual Worker secret exists; the consumer checks it and records
`threads_token_missing` without any provider request. A configured token does not
enable manual publishing or create jobs.

## Credential lifecycle

Only `threads_basic` and `threads_content_publish` are needed. No Facebook token,
app secret, reply/insight/deletion permission, automatic refresh credential or
Cloudflare write credential is needed in this Worker. A profile read validates
identity; an actual publish still validates publish permission at Meta.

Do not assume the existing token is long-lived. Before sustained use, the operator
must establish its type, actual expiry and scopes using Meta's protected setup
tools, without putting its value in a ticket, chat, log or D1. A missing expiry is
displayed as unknown/rotation-required, not never-expiring. Provider revocation or
permission failures block the affected Threads job and expose only a bounded code.

Use an operator-managed secure refresh/replacement lifecycle for this manual pilot:

1. Record the actual expiry and arrange a private reminder at least seven days
   before it. Disable manual publishing while rotating.
2. For a valid long-lived token at least 24 hours old, use Meta's supported
   `refresh_access_token` operation (`grant_type=th_refresh_token`) from a protected
   operator environment. A short-lived token requires the supported exchange;
   expired/revoked credentials require reauthorisation. Verify current Meta rules
   before the operation. An exchange app secret, if needed there, remains separate
   from Facebook and outside this Worker.
3. Capture the returned credential and actual lifetime directly into the
   environment's secret store; update the GitHub secret and expiry variable, then
   securely redeliver the Worker secret through the approved deployment mechanism.
   A secret configured only locally or only in GitHub has not necessarily reached
   Cloudflare. Do not log request URLs or token responses. No refresh token is
   written to D1, and this runtime never calls Cloudflare to replace its own secret.
4. Run the read-only connection check, verify the expected account and expiry
   status, then explicitly re-enable manual publishing if authorised. Review held
   and failed rows; rotation does not retry unknown outcomes or resurrect cancelled
   jobs. Later deliberate reposts need new request identities.

## Structural evidence and remaining provider acceptance

Checks performed locally:

- Wrangler type generation and `npm run typecheck`.
- `npm run build`: all four Worker dry-run bundles, with branding check passing.
  `XDG_CONFIG_HOME` was directed into the scratch workspace because the sandbox
  home has no writable Wrangler config directory.
- All 56 migrations on fresh SQLite; populated 0056 upgrade preserving an old
  direct request and every existing trigger; no foreign-key violations; zero
  Threads publication rows; automatic=true rejected by CHECK.
- Focused local SQLite checks of the actual four manual API workflows, all three
  transition reasons, exact replay, changed-selection conflicts, Threads-only
  isolation, ordinary approval with missing configuration, direct-empty rejection,
  history and cancellation. Concurrent identical/conflicting bulk requests retain
  exactly the winning identity. Missing actual Worker token sends zero remote
  requests; a stale publish is held. No Threads provider response was simulated.
- Existing Bluesky and Facebook focused checks passed via `node --import tsx`
  (the `tsx` CLI IPC socket is unavailable in this sandbox). The older thumbnail
  fixture now installs 0056 before using the current Admin API.
- Renderer syntax and a render in an isolated working copy with missing optional
  Threads configuration; identity/token never defaults to another environment.
- `git diff --check`.

Provider research used [Meta's official Postman collection](https://www.postman.com/meta/threads/collection/dht3nzz/threads-api),
its [text-container parameters](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api),
and [publish request](https://www.postman.com/meta/threads/request/34203612-c940a17f-e719-4b5b-9d28-7390bc658fb7).
This confirmed the separate create/publish operation and explicit link attachment.
Meta's direct posts, troubleshooting and token reference pages returned HTTP 429
or were inaccessible during this task. Therefore this handover does not claim full
independent verification of the current reference-page limits, container-status
or token-lifetime wording. The implementation uses conservative byte limits,
runtime `quota_usage/config` validation, bounded readiness polling and held publish
ambiguity. Before enabling the real pilot, the operator must confirm the current
[posts](https://developers.facebook.com/docs/threads/posts/),
[troubleshooting](https://developers.facebook.com/docs/threads/troubleshooting/)
and [token lifecycle](https://developers.facebook.com/docs/threads/get-started/long-lived-tokens/)
references and accept the real API behaviour. No contract decision is unresolved;
provider operational acceptance and that reference verification remain outstanding.

## Exact next operational steps — operator only

None of these steps was executed by this development task.

1. Review the PR. A merge to `main` touches existing automatic core deployment
   paths and can also trigger the separate existing email workflow. Review those
   deployment consequences before an authorised merge; creating this branch/PR
   does not deploy.
2. For the initial TEST deployment, leave the optional Threads credential and
   identity settings absent. Existing TEST account/D1/authentication settings stay
   independently configured. The core workflow renders account bindings, checks
   D1 ownership, creates the Threads Queue, applies migrations and deploys the
   Workers. Verify 0056 and both Queue producer bindings plus the consumer.
   For an authorised manual re-run use the existing Deploy UK AQ Media workflow;
   do not copy a LIVE credential or account ID into TEST.
3. Through the TEST protected Media admin proxy, GET Threads settings and confirm
   manual unavailable, automatic=false, missing-config reason, no historical rows.
   POST the connection check and confirm its bounded missing-config result. A PUT
   enabling manual Threads must be rejected. Verify ordinary approval with no
   social flags still works, explicit Threads selection fails before approval,
   and all-false direct publish is rejected. Inspect bounded history/list state.
4. Verify existing public Approved feed, discovery/scheduler, Facebook/Bluesky
   controls/history and News email operate independently using their existing
   authorised TEST acceptance procedures. Do not enable those remote channels
   merely to test Threads. The initial pilot does not require TEST Threads posting.
5. Implement/accept the separate TEST Ops dashboard follow-up before relying on
   visible Threads checkboxes/All/None; this Media PR supplies the backend only.
6. After structural review and the TEST non-remote checks, the operator may promote
   the complete changed active TEST files unchanged to LIVE, with the corresponding
   forward migration and generated types/configuration templates. Do not promote
   `archive/`, local scratch, connector-baseline commits or TEST identifiers.
   Preserve LIVE-only external account/D1/Queue origins/secrets/settings. The existing
   token must be securely delivered to the actual Discovery Worker, not assumed
   present from a local file or repository secret. Apply the same template rendering
   and binding/migration ordering; never patch or develop differing LIVE code.
7. With the references above verified, GET/POST connection state and confirm the
   exact LIVE Threads profile. Explicitly enable manual publishing only. Authorise
   one deliberate real post with `post_to_threads:true` and both other flags false.
   Confirm original headline, intact attribution/direct publisher link, persisted
   genuine container and post IDs, one posted result, provider-returned permalink
   where available, no duplicate and unaffected other services. Verify an identical
   key replays without another post. Stop and reconcile if the outcome is uncertain;
   never create a new publication merely to test ambiguity.
8. Keep automatic publishing false. Further automatic implementation requires a
   separate decision/contract. Future code changes return to the normal TEST-first
   process after this initial pilot.

## File inventory and documentation handover

New active files: `packages/core/src/threads.ts`,
`apps/media-admin/src/threads.ts`, `apps/media-discovery/src/threads.ts`,
`apps/media-discovery/src/threads-env.d.ts`,
`migrations/0056_threads_manual_publications.sql`, and this handover.

Changed active files, each preserved before editing under the same relative path
in `archive/2026-11-02/`:

- `apps/media-admin/src/index.ts`
- `apps/media-admin/src/editorial-dashboard.ts`
- `apps/media-admin/src/direct-publish-eligibility.ts`
- `apps/media-discovery/src/index.ts`
- `packages/core/src/index.ts`
- `apps/media-admin/wrangler.jsonc`
- `apps/media-discovery/wrangler.jsonc`
- `scripts/render-wrangler-config.mjs`
- `.github/workflows/uk_aq_media_deploy.yml`
- `config/uk_aq_github_env_targets.csv`

Also regenerated `apps/media-admin/worker-configuration.d.ts` and
`apps/media-discovery/worker-configuration.d.ts`; adjusted the existing
`scripts/bluesky-publication-check.ts` fixture. Generated files and checks do not
receive source archives. No archive code was executed.

Chat-mode system-docs ownership should update the Threads implementation status,
API/configuration/runbook references and dashboard follow-up boundary after review,
without claiming deployment or acceptance until those occur. The authoritative
system-docs repository remains unchanged by this coding task.
