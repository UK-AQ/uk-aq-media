# AQ in the News HTML email implementation

Immediate contains one article, with publisher/date, wrapping linked headline,
separate 320 × 180 preview and direct publisher button. Daily uses text-left,
160 × 90 image-right rows that stack text before image below 620px. Both have
complete plain text and visible News, Manage preferences and Unsubscribe links.
Confirmation shares the branding and explains the existing 24-hour expiry and
that ignoring it leaves the subscription inactive.

The production styling follows the supplied Immediate and Daily HTML previews,
including the rounded container, blue accent rule, typography, spacing, separate
Daily count and footer treatment. Preview-only sample content, placeholder boxes
and explanatory mock-up notes are replaced with current authorised data and
secure operational links. Both heading artwork and UK AQ logo remain clickable.

## Branding and MIME

`images/UK-AQ-NEWS-1line-email-w900.png` is the existing 900 × 103 heading.
`images/UK-AQ-Logo-v3-2Lines.png` is the supplied 655 × 665 two-line logo.
Its email derivative, `UK-AQ-Logo-v3-2Lines-email.png`, is 192 × 195, prepared
with Pillow's LANCZOS resampling without changing the artwork. The heading
displays up to 450px wide; the logo displays at 86px (66px on small screens).

Run `node scripts/news-email-branding.mjs` after changing an email PNG. It
creates `images/news-email-branding.json`, the fixed base64 assets imported
by the Worker and read locally by the optional Pro sender. `npm run build`
checks that this generated file still matches both PNGs. The original large
logo is retained as the supplied source; only the email derivative is embedded.

The MIME tree is:

```text
multipart/alternative
  text/plain; UTF-8; base64
  multipart/related; type=text/html
    text/html; UTF-8; base64
    image/png; inline; Content-ID for the News heading
    image/png; inline; Content-ID for the UK AQ logo
```

Boundary identifiers are stable per delivery and shorter than 70 characters.
Content-IDs include the stable logical Message-ID digest, match the HTML
references and remain stable across retries and transport choice. Lines use
CRLF; base64 is wrapped at 76 columns. Subjects remain fixed ASCII strings;
editorial Unicode is confined to encoded bodies. From, Reply-To, Message-ID,
Date and active-message one-click unsubscribe headers retain their existing
identities and sources. Image alt text, the plain-text alternative and visible News footer link retain
a readable branding fallback when images are disabled.

## Article previews

The email and public Worker now call the same core `publicPreviewImageUrl`
helper. Selection still requires both article/source permissions, matches
retained local-image provenance when applicable, preserves existing image
versioning and supports only already-authorised first-party placeholders.
The public image route continues to enforce current approval and policy at
fetch time. Email uses the contract's current standalone public origin,
`https://uk-aq-media-public.uk-aq-media.workers.dev`; no new configuration is
required. The News-page destination instead follows `NEWS_EMAIL_SITE_ORIGIN`.

Publisher images remain ordinary remote Media URLs, never MIME attachments.
Their only query parameter is the existing article-image version. Headline,
image and action each point directly to `canonical_url`. No summaries,
article-body text, tracking pixels, click redirects or subscriber image
parameters are added. Missing authorised previews produce text-only articles.

## Size and optional Pro fallback

Both composers enforce a maximum 250,000-byte complete serialized MIME message.
The existing 200,000-byte fallback HTTP request limit and 180,000-byte plain-text
guard remain; HTML has a 200,000-byte guard. The Worker checks the exact JSON
request envelope even for the primary transport, so an otherwise-supported
message remains compatible with explicitly selected fallback delivery.

Daily preflights all representations, including CRLF, UTF-8, base64 expansion,
markup, headers, boundaries and both PNGs. An exceeded size limit or a window
containing more than 500 articles uses the existing operator-hold state and
does not send, split, drop articles or advance the cursor. The number of articles
that fits below these byte caps depends on metadata length and image availability.

The Pro sender emits the same MIME format from the same JSON payload and asset
manifest. Its authentication, durable receipt journal/fingerprint, Message-ID,
unknown-outcome quarantine and SMTP error classification are unchanged. When
fallback is authorised for deployment, update its code and shared asset manifest
together before selecting it. This implementation does not enable that service.

## Validation and deployment boundary

Validation is limited to TypeScript checking, local Wrangler dry-run builds,
Python syntax and local MIME/link/policy inspection. No D1 queries/migrations,
deployment, configuration changes or email delivery are part of this task.

An authorised TEST deployment must be followed by genuine confirmation,
Immediate and Daily deliveries, checking desktop/mobile rendering, blocked-image
fallback, publisher destinations, unsubscribe/manage behaviour, mailbox placement,
digest holds and any separately authorised Pro fallback operation. Gmail,
Outlook and Apple Mail rendering has not been verified by these structural checks.

The authoritative system documentation remains read-only. Its operational
handover should record two-logo CID branding, the shared public preview helper,
250,000-byte MIME and 200,000-byte fallback-envelope caps, and coordinated
fallback asset delivery after deployment/acceptance status is established.
