import assert from 'node:assert/strict';
import {
  FacebookProviderError, classifyStaleFacebookPosting, createFacebookPost,
  readFacebookPost, validateFacebookIdentity,
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

let request: { url: string; init?: RequestInit } | undefined;
const identity = await validateFacebookIdentity(token, async (url, init) => {
  request = { url, init };
  return json({ id: '1336337862891538', name: 'UK AQ - ukaq.co.uk' });
});
assert.deepEqual(identity, { id: '1336337862891538', name: 'UK AQ - ukaq.co.uk', nameDrift: false });
assert.match(request?.url ?? '', /\/v26\.0\/me\?fields=id%2Cname$/);
assert.equal(new Headers(request?.init?.headers).get('authorization'), `Bearer ${token}`);
assert(!request?.url.includes(token));

assert.deepEqual(await errorKind(() => validateFacebookIdentity(token,
  async () => json({ id: 'other', name: 'Other' }))),
{ code: 'facebook_identity_mismatch', kind: 'blocked' });
assert.equal((await validateFacebookIdentity(token,
  async () => json({ id: '1336337862891538', name: 'Renamed Page' }))).nameDrift, true);

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

assert.equal(classifyStaleFacebookPosting(null), 'queued');
assert.equal(classifyStaleFacebookPosting('2026-09-20T00:00:00.000Z'), 'unknown_remote_state');
console.log('facebook provider checks passed');
