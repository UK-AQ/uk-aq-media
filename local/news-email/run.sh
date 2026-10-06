#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Optional fallback only. App Password stays in this ignored Pro-local .env.
# GOOGLE_SMTP_USERNAME may also be provisioned separately as a Worker secret.
set -a
source .env
set +a
exec /usr/bin/env python3 local/news-email/sender.py
