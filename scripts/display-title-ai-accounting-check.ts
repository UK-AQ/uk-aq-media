import assert from 'node:assert/strict';
import {
  DISPLAY_TITLE_AI_MAX_OUTPUT_TOKENS,
  NEURON_MICRO_UNITS,
  calculateNeuronMicrounits,
  ceilingWholeNeurons,
  displayTitleNeuronRates,
  inspectDisplayTitleResponse,
  parseDisplayTitleUsage,
  prepareDisplayTitleRequest,
} from '@uk-aq-media/enrichment';
import { presentAiUsage } from '../apps/media-admin/src/index';

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
