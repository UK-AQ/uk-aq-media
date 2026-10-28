# News email deployment and promotion

This handover describes the TEST PR implementation, not deployment or sending
approval. Authoritative system docs remain read-only to coding agents.

## Existing configuration reused

No new repository variable is required. The manual email workflow uses:

| Repository variable | Required meaning |
| --- | --- |
| `NEWS_EMAIL_TURNSTILE_HOSTNAMES` | The single authoritative comma-separated website hostname list for browser origins and Turnstile verification. |
| `NEWS_EMAIL_SITE_ORIGIN` | One canonical HTTPS website destination for every email website link, including the header logo. Must match one derived permitted origin. |
| `NEWS_EMAIL_ENABLED` | Explicit `true` or `false`, unchanged by this PR. An enabled deployment still requires the existing manual opt-in, default false. |
| `UK_AQ_MEDIA_CLOUDFLARE_ACCOUNT_ID` | Selected Cloudflare account, mapped to `CLOUDFLARE_ACCOUNT_ID` by the workflow. |
| `UK_AQ_MEDIA_CFLARE_D1DB_ID` | Selected Media D1 UUID. |
| `SUPABASE_URL` | Selected subscription project's HTTPS Supabase origin. |
| `NEWS_EMAIL_PUBLIC_API_ORIGIN` | Selected email Worker's canonical HTTPS origin. |
| `UK_AQ_MEDIA_PUBLIC_URL` | Selected public Media Worker's canonical HTTPS origin. |

Hostname entries are trimmed and normalised to lowercase, then checked for valid
DNS-label syntax, length and canonical URL interpretation. Missing, empty,
duplicated (including case variants), wildcard, URL, path, port and malformed
entries fail closed. Each hostname permits exactly `https://<hostname>`.
Arbitrary subdomains, HTTP, paths and nondefault ports are not authorised by a
listed hostname. The request's Origin must equal one derived origin; only that
origin is reflected in CORS responses. `Vary: Origin`, OPTIONS handling and the
existing `news_subscribe` Turnstile action check remain.

The deployment validator and renderer check required account/D1 formats, reject
placeholder D1 identifiers, validate website/API/Supabase settings and enforce
manual opt-in for enabled sending. Existing read-only D1 ownership verification
still runs before Queue creation or migrations. No environment is inferred from
a repository name or hostname, and there is no default to another environment.

Existing secrets remain required and unchanged: `UK_AQ_MEDIA_CFLARE_API_TOKEN`,
`SB_SECRET_KEY`, `NEWS_EMAIL_TURNSTILE_SECRET`, `NEWS_EMAIL_TOKEN_SECRET`,
`NEWS_EMAIL_RATE_SECRET`, `UK_AQ_MEDIA_EMAIL_WORKER_HTTP_SECRET`,
`NEWS_EMAIL_OPERATOR_SECRET`, `GOOGLE_SMTP_USERNAME`,
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and
`GOOGLE_OAUTH_REFRESH_TOKEN`. The optional Pro fallback retains the existing
`NEWS_EMAIL_SENDER_URL`/`NEWS_EMAIL_SENDER_SECRET` pair and its local SMTP
App Password configuration. No secret goes into Pages.

## Residual environment-selection risk

Format validation cannot establish that otherwise valid settings belong to the
intended TEST or LIVE environment. D1 ownership establishes that the database is
in the selected account, but cannot detect a consistently selected wrong account
and database. It also cannot establish that the Supabase URL/service key, email
API, public Media endpoint, Turnstile site/secret, website destination and SMTP
credentials all belong to the intended environment.

Before any separately authorised deployment, manually review the repository and
branch, selected Cloudflare account/D1, Supabase project and service credential,
both Worker endpoints, canonical website destination, allowed website hostnames,
Turnstile credentials/context, SMTP credentials and delivery-enabled setting
against the approved environment. Do not derive an independent expected-identity
copy or rely on syntactic checks to prove environmental isolation.

## TEST and LIVE relationship

For TEST, use only approved TEST hostnames, canonical TEST website, account, D1,
Supabase project, Workers and credentials. A second-origin acceptance test needs
a second explicitly approved TEST hostname, not a LIVE hostname.

For eventual LIVE, one LIVE email Worker accepts the public and beta website
hostnames from the existing hostname list. Both websites call that same Worker
and use its single LIVE subscriber database. `NEWS_EMAIL_SITE_ORIGIN` stays the
public LIVE origin, including emails to beta subscribers. No separate beta email
service or subscriber data is introduced, and beta subscribers need not register
again when the public entry links launch.

## Links and security preserved

Confirmation, Manage and visible Unsubscribe links use the canonical site's
`/news-by-email/#confirm=...`, `#manage=...` and `#unsubscribe=...`.
Token formats, hashing, expiry and secure-fragment handling are unchanged.
The UK AQ header logo now links to the configured canonical site's homepage.
Publisher article URLs and the existing View all AQ in the News route remain
unchanged. MIME layout, inline assets and content remain unchanged.

The MIME serializer and optional Pro sender validate the direct subscription
paths. RFC 8058 retains its token-bearing API POST endpoint, not a website
fragment. The browser still handles previously issued `/news/#...` links.
Operator and scheduler authentication, Turnstile verification, token validation
and rate limiting remain independent of browser-origin authorisation.

## Complete-file promotion dependencies

Promote the following complete source/configuration files together after TEST
acceptance, using the same application source in each environment:

- `apps/media-email/src/common.ts`
- `apps/media-email/src/config.mjs`
- `apps/media-email/src/config.d.mts`
- `apps/media-email/src/index.ts`
- `apps/media-email/src/public.ts`
- `apps/media-email/src/delivery.ts`
- `apps/media-email/src/message.ts`
- `apps/media-email/src/presentation.ts`
- `apps/media-email/wrangler.jsonc`
- `scripts/render-wrangler-config.mjs`
- `scripts/validate-news-email-deployment.mjs`
- `scripts/news-email-corrections-check.ts`
- `.github/workflows/uk_aq_media_email_deploy.yml`
- `config/uk_aq_github_env_targets.csv`
- `local/news-email/sender.py`
- This handover.

The existing branding/generated assets and core dependencies still need their
matching release versions. If the Pro fallback is configured, update its code
under separate deployment approval before resuming fallback use. Do not promote
TEST archives, rendered configuration or credentials. No schema change is needed.

## Validation, later deployment and rollback

Only local syntax/type/configuration checks and the existing offline email
serialization checks accompany this change. Real browser, Turnstile,
subscription, Queue, SMTP and email acceptance await explicitly authorised TEST
deployment and operation. No external settings, data or services were changed.

After separate approval, review existing settings and credentials as above.
Deploy TEST with sending disabled, then deploy matching Pages using its own
CNAME and existing API/site-key settings. The existing email workflow ensures
the Queue, applies pending migrations and manages secrets: review those effects
before authorising the workflow. Deployment alone does not authorise activation
or sending. Later approved real acceptance must cover both configured TEST
origins, rejected origins, canonical homepage/subscription links, confirmation,
Immediate/Daily, management, unsubscribe and RFC 8058.

Rollback restores matching Worker, optional sender, Pages and configuration.
Keep the canonical destination stable for already issued links. Do not rewind
subscriber data, tokens, activation state, schedules or Queue state. Archive
snapshots are reference only and must not be executed.

## Authoritative system-doc handover

Update `media/media-news-email-contract.md` with the shared hostname authority
for browser origins and Turnstile, separate canonical destination (including the
logo), direct fragment routes, unchanged one-click endpoint and one shared LIVE
subscriber authority. Update `media/media_contract.md` deployment guidance with
the retained validation/ownership gates and necessary manual environment review.
The website handover describes CNAME metadata, normal indexing and release scope.
No authoritative documentation was edited.
