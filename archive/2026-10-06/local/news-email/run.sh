#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Existing ignored Pro-local .env; never copy these values into Cloudflare/GitHub.
set -a
source .env
set +a
exec /usr/bin/env python3 local/news-email/sender.py
