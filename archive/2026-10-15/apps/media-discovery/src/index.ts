import {
  DiscoveryMessageSchema, displayTitleNeuronRates, recordQueueFailure, runSourceScan,
  CAWS_INDEX_ROUTE_KEY, configuredCawsIndex, configuredDsawspIndex,
  configuredNcasRouteKeys, configuredPublisherRssRouteKeys, DSAWSP_INDEX_ROUTE_KEY,
  scheduledGuardianRouteKeys,
  type DiscoveryMessage, type DisplayTitleAiRuntime,
} from '@uk-aq-media/discovery';
import { wakeNewsEmailOutbox, json, loadAuthorRules, loadSource, secretMatches } from '@uk-aq-media/core';
import {
  completeGdeltFile, failGdeltRun, finishGdeltRun, ingestGdeltChunk,
  startGdeltFile, startGdeltRun,
} from '@uk-aq-media/gdelt/ingest';
import { GDELT_MAX_INGEST_BODY_BYTES } from '@uk-aq-media/gdelt';
import { consumeBluesky, reconcileBlueskyQueue } from './bluesky';
import { consumeFacebook, reconcileFacebookQueue } from './facebook';

async function reconcileSocialQueues(env: MediaDiscoveryEnv): Promise<void> {
  try { await reconcileBlueskyQueue(env); }
  catch { console.error(JSON.stringify({ event: 'bluesky_wakeup_failed' })); }
  try { await reconcileFacebookQueue(env); }
  catch { console.error(JSON.stringify({ event: 'facebook_wakeup_failed' })); }
}

const NEURON_MICRO_UNITS = 1_000_000;
const MAX_EMPTY_GDELT_START_BODY_READS = 8;

export async function assertEmptyGdeltStartBody(request: Request): Promise<void> {
  const declared = request.headers.get('content-length')?.trim() ?? '';
  if (/^\d+$/.test(declared) && Number(declared) > 0) {
    throw new Error('gdelt_start_body_forbidden');
  }
  if (request.body === null) return;

  const reader = request.body.getReader();
  try {
    for (let reads = 0; reads < MAX_EMPTY_GDELT_START_BODY_READS; reads++) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.byteLength > 0) throw new Error('gdelt_start_body_forbidden');
    }
    throw new Error('gdelt_start_body_forbidden');
  } finally {
    try { await reader.cancel(); }
    catch { /* The body is already closed or cancelled. */ }
    reader.releaseLock();
  }
}

async function readGdeltJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
      'application/json') throw new Error('gdelt_json_content_type_required');
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > GDELT_MAX_INGEST_BODY_BYTES) throw new Error('gdelt_ingest_body_too_large');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > GDELT_MAX_INGEST_BODY_BYTES) throw new Error('gdelt_ingest_body_too_large');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new Error('gdelt_invalid_json'); }
}

function noStore(value: unknown, status = 200): Response {
  const response = json(value, status);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

async function handleGdeltIngest(request: Request, env: MediaDiscoveryEnv,
  pathname: string): Promise<Response> {
  if (request.method !== 'POST') {
    const response = noStore({ error: 'method_not_allowed' }, 405);
    response.headers.set('Allow', 'POST');
    return response;
  }
  if (!await secretMatches(request.headers.get('x-uk-aq-gdelt-ingest-secret'),
    env.UK_AQ_MEDIA_GDELT_INGEST_SECRET)) return noStore({ error: 'unauthorized' }, 401);
  try {
    if (pathname === '/gdelt/web-ngrams/runs/start') {
      await assertEmptyGdeltStartBody(request);
      return noStore(await startGdeltRun(env.MEDIA_DB));
    }
    const body = await readGdeltJson(request);
    if (pathname === '/gdelt/web-ngrams/files/start') {
      return noStore(await startGdeltFile(env.MEDIA_DB, body));
    }
    if (pathname === '/gdelt/web-ngrams/files/chunk') {
      return noStore(await ingestGdeltChunk(env.MEDIA_DB, body));
    }
    if (pathname === '/gdelt/web-ngrams/files/complete') {
      return noStore(await completeGdeltFile(env.MEDIA_DB, body));
    }
    if (pathname === '/gdelt/web-ngrams/runs/finish') {
      return noStore(await finishGdeltRun(env.MEDIA_DB, body));
    }
    if (pathname === '/gdelt/web-ngrams/runs/fail') {
      return noStore(await failGdeltRun(env.MEDIA_DB, body));
    }
    return noStore({ error: 'not_found' }, 404);
  } catch (error) {
    const known = error instanceof Error && /^gdelt_[a-z0-9_]+$/.test(error.message);
    const code = known
      ? error.message.slice(0, 100) : 'gdelt_ingest_failed';
    console.error(JSON.stringify({ event: 'gdelt_ingest_failed', error_code: code }));
    return noStore({ error: code }, code.endsWith('_not_found') ? 404 : known ? 400 : 503);
  }
}

function configuredDisplayTitleAi(env: MediaDiscoveryEnv): DisplayTitleAiRuntime | undefined {
  const model = String(env.MEDIA_AI_MODEL).trim();
  const perRun = Number(env.MEDIA_AI_MAX_REQUESTS_PER_RUN);
  const dailyNeuronBudget = Number(env.MEDIA_AI_DAILY_NEURON_BUDGET);
  const accountFreeNeurons = Number(env.MEDIA_AI_ACCOUNT_FREE_NEURONS_PER_DAY);
  const maximumTitlesPerRequest = Number(env.MEDIA_AI_MAX_TITLES_PER_REQUEST);
  if (!/^@cf\/[a-z0-9._/-]+$/i.test(model) || model.length > 200 ||
      !Number.isSafeInteger(perRun) || perRun < 1 || perRun > 10 ||
      !Number.isSafeInteger(dailyNeuronBudget) || dailyNeuronBudget < 1 ||
      !Number.isSafeInteger(accountFreeNeurons) || accountFreeNeurons < 1 ||
      dailyNeuronBudget > accountFreeNeurons ||
      !Number.isSafeInteger(dailyNeuronBudget * NEURON_MICRO_UNITS) ||
      !Number.isSafeInteger(accountFreeNeurons * NEURON_MICRO_UNITS) ||
      !Number.isSafeInteger(maximumTitlesPerRequest) ||
      maximumTitlesPerRequest < 1 || maximumTitlesPerRequest > 5 ||
      displayTitleNeuronRates(model) === null) {
    console.warn(JSON.stringify({ event: 'display_title_ai_configuration_disabled' }));
    return undefined;
  }
  return { binding: env.AI, model, maximum_requests_per_run: perRun,
    daily_neuron_budget: dailyNeuronBudget,
    account_free_neurons_per_day: accountFreeNeurons,
    maximum_titles_per_request: maximumTitlesPerRequest };
}

async function enqueueScheduledDiscovery(env: MediaDiscoveryEnv): Promise<number> {
  try {
    // This explicit adapter allowlist prevents enabling unfinished publishers through D1 alone.
    // Request data never participates in this internally selected, bounded work list.
    const [aqn, guardian, bbc, sky, independent, carbonBrief, openaq, physOrg, exeter,
      seeTheAir, mumsForLungs, dsawsp, caws, ncas] = await Promise.all([
      loadSource(env.MEDIA_DB, 'air-quality-news'),
      loadSource(env.MEDIA_DB, 'the-guardian'),
      loadSource(env.MEDIA_DB, 'bbc-news'),
      loadSource(env.MEDIA_DB, 'sky-news'),
      loadSource(env.MEDIA_DB, 'the-independent'),
      loadSource(env.MEDIA_DB, 'carbon-brief'),
      loadSource(env.MEDIA_DB, 'openaq'),
      loadSource(env.MEDIA_DB, 'phys-org'),
      loadSource(env.MEDIA_DB, 'university-of-exeter'),
      loadSource(env.MEDIA_DB, 'see-the-air'),
      loadSource(env.MEDIA_DB, 'mums-for-lungs'),
      loadSource(env.MEDIA_DB, 'dsawsp'),
      loadSource(env.MEDIA_DB, 'communities-against-woodsmoke'),
      loadSource(env.MEDIA_DB, 'ncas'),
    ]);
    const messages: DiscoveryMessage[] = [];
    if (aqn?.enabled) messages.push({ type: 'source_scan', source_key: 'air-quality-news' });
    if (guardian?.enabled) {
      const rules = await loadAuthorRules(env.MEDIA_DB, 'the-guardian');
      for (const routeKey of scheduledGuardianRouteKeys(guardian, rules)) {
        messages.push({ type: 'source_scan', source_key: 'the-guardian', route_key: routeKey });
      }
    }
    for (const source of [bbc, sky, independent, carbonBrief, openaq, physOrg, exeter,
      seeTheAir, mumsForLungs]) {
      if (!source?.enabled) continue;
      for (const routeKey of configuredPublisherRssRouteKeys(source)) {
        messages.push({ type: 'source_scan', source_key: source.source_key, route_key: routeKey });
      }
    }
    if (dsawsp?.enabled && configuredDsawspIndex(dsawsp)) {
      messages.push({ type: 'source_scan', source_key: 'dsawsp',
        route_key: DSAWSP_INDEX_ROUTE_KEY });
    }
    if (caws?.enabled && configuredCawsIndex(caws)) {
      messages.push({ type: 'source_scan', source_key: 'communities-against-woodsmoke',
        route_key: CAWS_INDEX_ROUTE_KEY });
    }
    if (ncas?.enabled) {
      for (const routeKey of configuredNcasRouteKeys(ncas)) {
        messages.push({ type: 'source_scan', source_key: 'ncas', route_key: routeKey });
      }
    }
    if (messages.length === 0) return 0;
    await env.MEDIA_DISCOVERY_QUEUE.sendBatch(messages.map(body => ({ body })));
    return messages.length;
  } catch {
    await recordQueueFailure(env.MEDIA_DB, 'discovery_schedule_failed');
    console.error(JSON.stringify({ event: 'discovery_schedule_failed' }));
    throw new Error('discovery_schedule_failed');
  }
}

export default {
  async fetch(request, env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/gdelt/web-ngrams/')) {
      const response = await handleGdeltIngest(request, env, url.pathname);
      if (response.ok && url.pathname === '/gdelt/web-ngrams/files/chunk') {
        if (ctx) ctx.waitUntil(wakeNewsEmailOutbox(env));
        // Promotions may fill image metadata as well as creating approvals.
        try { await reconcileBlueskyQueue(env); }
        catch { console.error(JSON.stringify({ event: 'bluesky_wakeup_failed' })); }
      }
      return response;
    }
    if (url.pathname !== '/scheduler/run') return json({ error: 'not_found' }, 404);
    if (request.method !== 'POST') {
      const response = json({ error: 'method_not_allowed' }, 405);
      response.headers.set('Allow', 'POST');
      return response;
    }
    const suppliedSecret = request.headers.get('x-uk-aq-worker-http-secret');
    if (!await secretMatches(suppliedSecret, env.UK_AQ_MEDIA_WORKER_HTTP_SECRET)) {
      return json({ error: 'unauthorized' }, 401);
    }
    try {
      const queued = await enqueueScheduledDiscovery(env);
      return json({ ok: true, queued }, 202);
    } catch {
      return json({ error: 'discovery_schedule_failed' }, 503);
    } finally {
      // Social recovery must not depend on publisher discovery enqueue succeeding.
      await reconcileSocialQueues(env);
    }
  },
  async scheduled(_controller, env): Promise<void> {
    try { await enqueueScheduledDiscovery(env); }
    finally { await reconcileSocialQueues(env); }
  },
  async queue(batch, env, ctx?: ExecutionContext): Promise<void> {
    if (batch.queue === 'uk-aq-media-bluesky') {
      for (const message of batch.messages) await consumeBluesky(message, env);
      return;
    }
    if (batch.queue === 'uk-aq-media-facebook') {
      for (const message of batch.messages) await consumeFacebook(message, env);
      // A permitted local-copy acquisition in this path can also make an
      // existing automatic Bluesky intent ready; isolate the follow-up failure.
      try { await reconcileBlueskyQueue(env); }
      catch { console.error(JSON.stringify({ event: 'bluesky_wakeup_failed' })); }
      return;
    }
    if (batch.queue !== 'uk-aq-media-discovery') {
      for (const message of batch.messages) message.ack();
      console.error(JSON.stringify({ event: 'unknown_queue', queue: batch.queue.slice(0, 100) }));
      return;
    }
    for (const message of batch.messages) {
      const parsed = DiscoveryMessageSchema.safeParse(message.body);
      if (!parsed.success || parsed.data.type === 'article_enrich') {
        // Not operational in this phase: never acknowledge unimplemented work as completed.
        await recordQueueFailure(env.MEDIA_DB, 'unsupported_discovery_message', message.id, message.attempts);
        console.error(JSON.stringify({ event: 'unsupported_discovery_message', message_id: message.id }));
        message.retry({ delaySeconds: 300 });
        continue;
      }
      try {
        await runSourceScan(env.MEDIA_DB, parsed.data.source_key, parsed.data.route_key,
          message.id, message.attempts, configuredDisplayTitleAi(env));
        if (ctx) ctx.waitUntil(wakeNewsEmailOutbox(env));
        await reconcileSocialQueues(env);
        message.ack();
      } catch {
        console.error(JSON.stringify({ event: 'discovery_message_failed', message_id: message.id }));
        message.retry({ delaySeconds: 300 });
      }
    }
  },
} satisfies ExportedHandler<MediaDiscoveryEnv, unknown>;
