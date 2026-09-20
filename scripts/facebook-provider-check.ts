import assert from 'node:assert/strict';
import {
  FacebookProviderError, classifyStaleFacebookPosting, createFacebookPost,
  markFacebookPosted, persistFacebookConfirmedPostId, readFacebookPost,
  recoverFacebookKnownIdPosting, validateFacebookIdentity, type FacebookPublication,
} from '../apps/media-discovery/src/facebook';

const token = 'local-test-credential';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const errorKind = async (operation: () => Promise<unknown>) => {
  try { await operation(); }
  catch (error) {
    assert(error instanceof FacebookProviderError);
    return { code: error.code, kind: error.kind };
  }
  assert.fail('expected FacebookProviderError');
};

const oversizedError = new FacebookProviderError('x'.repeat(101), 'blocked');
assert.equal(oversizedError.code, 'facebook_provider_error');
assert.equal(oversizedError.message, 'facebook_provider_error');

let request: { url: string; init?: RequestInit } | undefined;
const identity = await validateFacebookIdentity(token, async (url, init) => {
  request = { url, init };
  return json({ id: '1336337862891538', name: 'UK Air Quality - ukaq.co.uk' });
});
assert.deepEqual(identity, { id: '1336337862891538', name: 'UK Air Quality - ukaq.co.uk', nameDrift: false });
assert.match(request?.url ?? '', /\/v26\.0\/me\?fields=id%2Cname$/);
assert.equal(new Headers(request?.init?.headers).get('authorization'), `Bearer ${token}`);
assert(!request?.url.includes(token));

assert.deepEqual(await errorKind(() => validateFacebookIdentity(token,
  async () => json({ id: 'other', name: 'Other' }))),
{ code: 'facebook_identity_mismatch', kind: 'blocked' });
assert.equal((await validateFacebookIdentity(token,
  async () => json({ id: '1336337862891538', name: 'Renamed Page' }))).nameDrift, true);
assert.deepEqual(await errorKind(() => validateFacebookIdentity(token, async () => {
  throw new Error('timeout');
})), { code: 'facebook_transport_failure', kind: 'definite_pre_dispatch' });
assert.deepEqual(await errorKind(() => validateFacebookIdentity(token,
  async () => new Response('{'))),
{ code: 'facebook_response_invalid', kind: 'definite_pre_dispatch' });
assert.deepEqual(await errorKind(() => validateFacebookIdentity(token,
  async () => json({ error: { code: 80001, message: 'Too many calls' } }, 429))),
{ code: 'facebook_error_80001', kind: 'known_safe_retry' });

const createInput = { token, title: 'Headline', publisher: 'Publisher',
  canonical_url: 'https://publisher.example/article', template: 'From {publisher}',
  markRemoteRequestStarted: async () => undefined };
let marked = false;
const created = await createFacebookPost({ ...createInput,
  markRemoteRequestStarted: async () => { marked = true; } }, async (url, init) => {
  assert(marked, 'dispatch marker must be durable before fetch');
  assert.equal(url, 'https://graph.facebook.com/v26.0/1336337862891538/feed');
  assert.equal(init?.method, 'POST');
  assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
  assert.deepEqual([...new URLSearchParams(String(init?.body))].map(([key]) => key), ['message', 'link']);
  return json({ id: '1336337862891538_123' });
});
assert.deepEqual(created, { facebookPostId: '1336337862891538_123', permalinkUrl: null });

assert.deepEqual(await errorKind(() => createFacebookPost(createInput, async () => json({ ok: true }))),
  { code: 'facebook_post_id_invalid', kind: 'unknown_remote_state' });
assert.deepEqual(await errorKind(() => createFacebookPost(createInput, async () => {
  throw new Error('timeout');
})), { code: 'facebook_transport_failure', kind: 'unknown_remote_state' });
assert.deepEqual(await errorKind(() => createFacebookPost(createInput,
  async () => new Response('{'))),
{ code: 'facebook_response_invalid', kind: 'unknown_remote_state' });
assert.deepEqual(await errorKind(() => createFacebookPost(createInput,
  async () => json({ error: { code: 80001, message: 'Too many calls' } }, 429))),
{ code: 'facebook_error_80001', kind: 'known_safe_retry' });
for (const code of [100, 190, 200]) {
  assert.deepEqual(await errorKind(() => createFacebookPost(createInput,
    async () => json({ error: { code, message: 'Rejected' } }, 400))),
  { code: `facebook_error_${code}`, kind: 'blocked' });
}

assert.deepEqual(await readFacebookPost('1336337862891538_123', token,
  async (url) => {
    assert.match(url, /\/v26\.0\/1336337862891538_123\?fields=id%2Cpermalink_url$/);
    return json({ id: '1336337862891538_123' });
  }), { facebookPostId: '1336337862891538_123', permalinkUrl: null });
assert.deepEqual(await errorKind(() => readFacebookPost('expected', token,
  async () => json({ id: 'different' }))),
{ code: 'facebook_post_id_mismatch', kind: 'blocked' });
assert.deepEqual(await errorKind(() => readFacebookPost('expected', token, async () => {
  throw new Error('timeout');
})), { code: 'facebook_transport_failure', kind: 'known_safe_retry' });
assert.deepEqual(await errorKind(() => readFacebookPost('expected', token,
  async () => new Response('{'))),
{ code: 'facebook_response_invalid', kind: 'known_safe_retry' });
for (const code of [100, 190, 200]) {
  assert.deepEqual(await errorKind(() => readFacebookPost('expected', token,
    async () => json({ error: { code, message: 'Rejected' } }, 400))),
  { code: `facebook_error_${code}`, kind: 'blocked' });
}

assert.equal(classifyStaleFacebookPosting(null), 'queued');
assert.equal(classifyStaleFacebookPosting('2026-09-20T00:00:00.000Z'), 'unknown_remote_state');

type LocalPublication = { id: number; status: string; facebook_post_id: string | null;
  remote_request_started_at: string | null; attempt_count: number; last_attempted_at: string | null;
  last_error_code: string | null; facebook_permalink_url: string | null; posted_at: string | null;
  reconciled_at: string | null; reconciliation_method: string | null; unknown_at: string | null };
const local = (postId: string | null = null): LocalPublication => ({ id: 1, status: 'posting',
  facebook_post_id: postId, remote_request_started_at: '2026-09-20T00:00:00.000Z',
  attempt_count: postId === null ? 0 : 1,
  last_attempted_at: '2026-09-20T00:00:00.000Z', last_error_code: null,
  facebook_permalink_url: null, posted_at: null, reconciled_at: null,
  reconciliation_method: null, unknown_at: null });

function localDb(row: LocalPublication): D1Database {
  const statement = (sql: string) => {
    let values: unknown[] = [];
    const result = {
      bind: (...bound: unknown[]) => { values = bound; return statementResult; },
      run: async () => {
        if (sql.includes('SET facebook_post_id = ?')) {
          const [postId] = values as [string];
          if (row.status !== 'posting' || !row.remote_request_started_at ||
              (row.facebook_post_id !== null && row.facebook_post_id !== postId)) return { meta: { changes: 0 } };
          if (row.facebook_post_id === null) row.attempt_count += 1;
          row.facebook_post_id = postId;
        } else if (sql.includes("SET status = 'posted'")) {
          const [permalink, postedAt, , , postId] = values as [string | null, string, string, number, string];
          if (row.status !== 'posting' || row.facebook_post_id !== postId) return { meta: { changes: 0 } };
          row.status = 'posted'; row.facebook_permalink_url ??= permalink; row.posted_at = postedAt;
          row.last_error_code = null;
        } else if (sql.includes('reconciliation_method = COALESCE')) {
          const [permalink, reconciledAt] = values as [string | null, string];
          if (row.status !== 'posted') return { meta: { changes: 0 } };
          row.facebook_permalink_url ??= permalink; row.reconciled_at ??= reconciledAt;
          row.reconciliation_method ??= 'exact_post_id';
        } else if (sql.includes('SET last_attempted_at = ?')) {
          const [attemptedAt, code] = values as [string, string];
          row.last_attempted_at = attemptedAt; row.last_error_code = code;
        } else if (sql.includes("SET status = 'unknown_remote_state'")) {
          const [code, unknownAt] = values as [string, string];
          row.status = 'unknown_remote_state'; row.last_error_code = code; row.unknown_at = unknownAt;
        }
        return { meta: { changes: 1 } };
      },
    };
    const statementResult = result;
    return result;
  };
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map(item => item.run())),
  };
  return db as unknown as D1Database;
}

const confirmed = local();
const confirmedDb = localDb(confirmed);
await persistFacebookConfirmedPostId(confirmedDb, 1, '1336337862891538_456', '2026-09-20T00:01:00.000Z');
assert.equal(confirmed.facebook_post_id, '1336337862891538_456');
assert.equal(confirmed.attempt_count, 1, 'confirmed create increments its attempt exactly once');
await markFacebookPosted(confirmedDb, 1, '1336337862891538_456', null, '2026-09-20T00:01:01.000Z');
assert.equal(confirmed.status, 'posted');
assert.equal(confirmed.attempt_count, 1, 'posted transition must not increment the confirmed attempt again');

const failedPersistence = local();
const failingDb = { prepare: () => ({ bind() { return this; },
  run: async () => { throw new Error('local_d1_failure'); } }) } as unknown as D1Database;
await assert.rejects(() => persistFacebookConfirmedPostId(failingDb, 1,
  '1336337862891538_457', '2026-09-20T00:01:00.000Z'), /local_d1_failure/);
assert.equal(failedPersistence.status, 'posting');
assert.equal(failedPersistence.facebook_post_id, null);

const conflicting = local('1336337862891538_existing');
assert.deepEqual(await errorKind(() => persistFacebookConfirmedPostId(localDb(conflicting), 1,
  '1336337862891538_different', '2026-09-20T00:01:00.000Z')),
{ code: 'facebook_confirmed_post_id_conflict', kind: 'local_state_conflict' });

const recovering = local('1336337862891538_789');
let recoveryMethod = '';
await recoverFacebookKnownIdPosting({ MEDIA_DB: localDb(recovering),
  UK_AQ_MEDIA_FACEBOOK_PAGE_TOKEN: token } as MediaDiscoveryEnv,
recovering as unknown as FacebookPublication,
async (_url, init) => {
  recoveryMethod = init?.method ?? 'GET';
  return json({ id: '1336337862891538_789', permalink_url: 'https://www.facebook.com/example/posts/789' });
});
assert.equal(recoveryMethod, 'GET', 'known-ID recovery must use read-back, never POST creation');
assert.equal(recovering.status, 'posted');
assert.equal(recovering.attempt_count, 1);
assert.equal(recovering.reconciliation_method, 'exact_post_id');

const transientRecovery = local('1336337862891538_999');
await recoverFacebookKnownIdPosting({ MEDIA_DB: localDb(transientRecovery),
  UK_AQ_MEDIA_FACEBOOK_PAGE_TOKEN: token } as MediaDiscoveryEnv,
transientRecovery as unknown as FacebookPublication, async () => { throw new Error('timeout'); });
assert.equal(transientRecovery.status, 'posting');
assert.equal(transientRecovery.facebook_post_id, '1336337862891538_999');
assert.equal(transientRecovery.attempt_count, 1);
assert.equal(transientRecovery.last_error_code, 'facebook_transport_failure');
console.log('facebook provider checks passed');
