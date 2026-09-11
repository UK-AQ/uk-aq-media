CREATE TABLE media_ai_neuron_requests (
  request_id TEXT PRIMARY KEY,
  logical_request_key TEXT NOT NULL UNIQUE,
  usage_date TEXT NOT NULL
    CHECK (length(usage_date) = 10
      AND usage_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  purpose TEXT NOT NULL CHECK (purpose = 'display_title'),
  record_kind TEXT NOT NULL CHECK (record_kind IN ('request', 'legacy_daily_call_counter')),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  prompt_version TEXT NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 200),
  input_neurons_per_million_tokens INTEGER NOT NULL
    CHECK (input_neurons_per_million_tokens >= 0),
  output_neurons_per_million_tokens INTEGER NOT NULL
    CHECK (output_neurons_per_million_tokens >= 0),
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  titles_attempted INTEGER NOT NULL CHECK (titles_attempted > 0),
  candidate_count INTEGER NOT NULL CHECK (candidate_count BETWEEN 1 AND 5),
  conservative_prompt_token_ceiling INTEGER NOT NULL
    CHECK (conservative_prompt_token_ceiling > 0),
  maximum_output_tokens INTEGER NOT NULL CHECK (maximum_output_tokens > 0),
  reserved_neuron_microunits INTEGER NOT NULL CHECK (reserved_neuron_microunits > 0),
  media_daily_budget_neuron_microunits INTEGER NOT NULL
    CHECK (media_daily_budget_neuron_microunits > 0),
  account_free_neuron_microunits INTEGER NOT NULL
    CHECK (account_free_neuron_microunits > 0),
  accounting_state TEXT NOT NULL CHECK (accounting_state IN ('reserved', 'reconciled')),
  usage_state TEXT NOT NULL
    CHECK (usage_state IN ('pending', 'recorded', 'missing_usage', 'malformed_usage',
      'provider_failure', 'reconciliation_failure', 'legacy_usage_unknown')),
  request_started_at TEXT,
  prompt_tokens INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens INTEGER CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  actual_neuron_microunits INTEGER
    CHECK (actual_neuron_microunits IS NULL OR actual_neuron_microunits >= 0),
  titles_generated INTEGER NOT NULL DEFAULT 0
    CHECK (titles_generated BETWEEN 0 AND candidate_count),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (accounting_state = 'reserved' OR (
    usage_state = 'recorded'
    AND prompt_tokens IS NOT NULL
    AND completion_tokens IS NOT NULL
    AND total_tokens IS NOT NULL
    AND actual_neuron_microunits IS NOT NULL
  )),
  CHECK (prompt_tokens IS NULL OR completion_tokens IS NULL OR total_tokens IS NULL
    OR total_tokens = prompt_tokens + completion_tokens),
  CHECK (record_kind = 'legacy_daily_call_counter' OR (
    request_count = 1
    AND titles_attempted = candidate_count
    AND input_neurons_per_million_tokens > 0
    AND output_neurons_per_million_tokens > 0
  ))
);

CREATE INDEX media_ai_neuron_requests_usage_date_idx
  ON media_ai_neuron_requests(usage_date);

-- Migration 0006 may have admitted title calls before this ledger existed. Its counter cannot
-- be converted into token usage. Preserve the counts and conservatively close that UTC day's
-- local budget rather than inventing token history or reopening potentially consumed capacity.
INSERT INTO media_ai_neuron_requests
  (request_id, logical_request_key, usage_date, purpose, record_kind, provider, model,
    prompt_version,
    input_neurons_per_million_tokens, output_neurons_per_million_tokens,
    request_count, titles_attempted, candidate_count, conservative_prompt_token_ceiling,
    maximum_output_tokens, reserved_neuron_microunits,
    media_daily_budget_neuron_microunits, account_free_neuron_microunits,
    accounting_state, usage_state, request_started_at, created_at, updated_at)
SELECT 'legacy-0006-' || usage_date, 'legacy-0006-daily:' || usage_date, usage_date,
  'display_title', 'legacy_daily_call_counter', 'cloudflare-workers-ai',
  'unknown:pre-neuron-ledger', 'unknown:pre-neuron-ledger', 0, 0,
  display_title_calls, display_title_calls, 1, 1, 64, 8000000000, 8000000000,
  10000000000, 'reserved', 'legacy_usage_unknown', updated_at, updated_at, updated_at
FROM media_ai_daily_usage
WHERE display_title_calls > 0;

ALTER TABLE media_ai_daily_usage RENAME TO media_ai_daily_usage_legacy;
