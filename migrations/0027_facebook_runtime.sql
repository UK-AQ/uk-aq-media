-- Stage 4B pins the deployed provider contract and records only bounded
-- connection-check state. Credentials and provider responses never enter D1.
ALTER TABLE media_facebook_settings ADD COLUMN last_identity_checked_at TEXT;
ALTER TABLE media_facebook_settings ADD COLUMN last_identity_observed_name TEXT;
ALTER TABLE media_facebook_settings ADD COLUMN last_identity_name_drift INTEGER NOT NULL DEFAULT 0
  CHECK (last_identity_name_drift IN (0, 1));
ALTER TABLE media_facebook_settings ADD COLUMN last_identity_error_code TEXT;

UPDATE media_facebook_settings
SET graph_api_version = 'v26.0', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1 AND graph_api_version IS NULL;

-- A different non-null version is deliberately left untouched so runtime
-- validation fails closed instead of silently rewriting operator state.
