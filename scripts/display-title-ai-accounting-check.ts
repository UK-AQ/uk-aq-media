import assert from 'node:assert/strict';
import {
  DISPLAY_TITLE_AI_MAX_OUTPUT_TOKENS,
  DISPLAY_TITLE_PROMPT_VERSION,
  LocalRequestBudget,
  NEURON_MICRO_UNITS,
  calculateNeuronMicrounits,
  ceilingWholeNeurons,
  displayTitleNeuronRates,
  inspectDisplayTitleResponse,
  parseDisplayTitleUsage,
  prepareDisplayTitleRequest,
  suggestDisplayTitleExplicit,
  type DisplayTitleNeuronLedger,
  type DisplayTitleProvider,
} from '@uk-aq-media/enrichment';
import { EXPLICIT_DISPLAY_TITLE_UPDATE_SQL, presentAiUsage } from '../apps/media-admin/src/index';

const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const rates = displayTitleNeuronRates(model);
assert.deepEqual(rates, {
  input_neurons_per_million_tokens: 26_668,
  output_neurons_per_million_tokens: 204_805,
});
assert.equal(displayTitleNeuronRates('@cf/example/unknown-model'), null);

assert.equal(calculateNeuronMicrounits(1_000_000, 1_000_000, rates),
  231_473 * NEURON_MICRO_UNITS);
assert.equal(calculateNeuronMicrounits(1, 0, rates), 26_668);
assert.equal(calculateNeuronMicrounits(0, 1, rates), 204_805);
assert.equal(ceilingWholeNeurons(1), 1);
assert.equal(ceilingWholeNeurons(NEURON_MICRO_UNITS), 1);
assert.equal(ceilingWholeNeurons(NEURON_MICRO_UNITS + 1), 2);

assert.deepEqual(parseDisplayTitleUsage({
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
}), { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
assert.deepEqual(parseDisplayTitleUsage({
  prompt_tokens: 100,
  completion_tokens: 0,
  total_tokens: 100,
}), { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 });
assert.equal(parseDisplayTitleUsage({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
}), null);
assert.equal(parseDisplayTitleUsage({
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 119,
}), null);
assert.deepEqual(inspectDisplayTitleResponse({
  response: JSON.stringify({ display_title: 'Air pollution evidence may affect policy' }),
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
}), {
  title: 'Air pollution evidence may affect policy',
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  usage_status: 'usable',
});
assert.deepEqual(inspectDisplayTitleResponse({
  response: JSON.stringify({ display_title: 'Invalid\nmultiline title' }),
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
}), {
  title: null,
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  usage_status: 'usable',
});
assert.deepEqual(inspectDisplayTitleResponse({
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
}), {
  title: null,
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  usage_status: 'usable',
});

const prepared = prepareDisplayTitleRequest({
  publisher: 'Air Quality News',
  title: 'A deliberately long publisher headline about air pollution and public health evidence',
  title_context: 'Publisher supplied RSS context.',
  author: 'Example Author',
  categories: ['Air pollution'],
});
assert.equal(prepared.candidate_count, 1);
assert.equal(prepared.maximum_output_tokens, DISPLAY_TITLE_AI_MAX_OUTPUT_TOKENS);
assert.ok(prepared.conservative_prompt_token_ceiling >
  new TextEncoder().encode(JSON.stringify(prepared.request)).byteLength);

let explicitProviderCalls = 0;
const explicitProvider: DisplayTitleProvider = {
  provider: 'cloudflare-workers-ai',
  model,
  version: DISPLAY_TITLE_PROMPT_VERSION,
  prepare: prepareDisplayTitleRequest,
  async suggest() {
    explicitProviderCalls++;
    return { title: 'Short AQ title', usage: {
      prompt_tokens: 100, completion_tokens: 5, total_tokens: 105,
    }, usage_status: 'usable' };
  },
};
const admittedKeys = new Set<string>();
const explicitLedger: DisplayTitleNeuronLedger = {
  async reserve(request) {
    if (admittedKeys.has(request.logical_request_key)) {
      return { status: 'denied', reason: 'duplicate_request' };
    }
    admittedKeys.add(request.logical_request_key);
    return { status: 'reserved', reservation: {
      request_id: 'explicit-request-1', reserved_neuron_microunits: 1,
    } };
  },
  async markRequestStarted() { return true; },
  async reconcile() { return true; },
  async retainReservation() {},
};
const explicitInput = { publisher: 'Policy-disabled publisher', title: 'Short AQ title',
  title_context: null, author: null, categories: [] };
const explicitFirst = await suggestDisplayTitleExplicit(explicitInput, explicitProvider,
  new LocalRequestBudget(1), explicitLedger, 'admin-display-title:42:stable-key',
  8_000, 10_000, 5);
const explicitReplay = await suggestDisplayTitleExplicit(explicitInput, explicitProvider,
  new LocalRequestBudget(1), explicitLedger, 'admin-display-title:42:stable-key',
  8_000, 10_000, 5);
assert.equal(explicitFirst.status, 'suggested');
assert.deepEqual(explicitReplay, { status: 'skipped', reason: 'duplicate_request' });
assert.equal(explicitProviderCalls, 1,
  'the explicit path must not infer twice for one durable logical request key');
assert.match(EXPLICIT_DISPLAY_TITLE_UPDATE_SQL, /ai_title_suggestion_state = 'pending'/);
assert.match(EXPLICIT_DISPLAY_TITLE_UPDATE_SQL, /ai_title_decided_at = NULL/);
assert.doesNotMatch(EXPLICIT_DISPLAY_TITLE_UPDATE_SQL, /\bdisplay_title\s*=/);
assert.doesNotMatch(EXPLICIT_DISPLAY_TITLE_UPDATE_SQL, /\bstatus\s*=/);
assert.doesNotMatch(EXPLICIT_DISPLAY_TITLE_UPDATE_SQL, /\bapproval_(?:method|at)\s*=/);
assert.doesNotMatch(EXPLICIT_DISPLAY_TITLE_UPDATE_SQL, /\bstatus\s+IN\b/);
assert.doesNotMatch(EXPLICIT_DISPLAY_TITLE_UPDATE_SQL, /\bsource_key\b/);

const presented = presentAiUsage({
  usage_date: '2026-09-11',
  ai_requests: 2,
  ai_titles_attempted: 2,
  legacy_usage_unknown_requests: 0,
  titles_generated_successfully: 1,
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  calculated_neuron_microunits: 6_762_900,
  outstanding_reserved_neuron_microunits: 1_000_000_000,
  accounted_neuron_microunits: 1_006_762_900,
  media_daily_budget_neuron_microunits: 8_000 * NEURON_MICRO_UNITS,
  account_free_neuron_microunits: 10_000 * NEURON_MICRO_UNITS,
});
assert.equal(presented.media_daily_neuron_budget, 8_000);
assert.equal(presented.configured_cloudflare_free_allocation_neurons, 10_000);
assert.equal(presented.media_budget_remaining, 6_993.2371);
assert.equal(presented.estimated_cloudflare_free_neurons_remaining, 8_993.2371);

console.log('display-title AI accounting checks passed');
