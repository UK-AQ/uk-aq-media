import assert from 'node:assert/strict';
import {
  fetchRemotePreviewImage, remotePreviewUrl, type PublisherDomainIdentity,
} from '@uk-aq-media/core';

const openaq: PublisherDomainIdentity = {
  source_key: 'openaq', canonical_domain: 'openaq.medium.com',
};
const bbc: PublisherDomainIdentity = {
  source_key: 'bbc-news', canonical_domain: 'bbc.co.uk',
};
const cambridgeNews: PublisherDomainIdentity = {
  source_key: 'discovered-publisher-7d08f774ec420c35',
  canonical_domain: 'cambridge-news.co.uk',
};
const unrelatedDynamicSource: PublisherDomainIdentity = {
  source_key: 'discovered-publisher-c592df415547ae79',
  canonical_domain: 'unrelated-news.example',
};
const bbcImageUrl = 'https://ichef.bbci.co.uk/ace/standard/240/cpsprodpb/example.jpg';
const cambridgeImageUrl = 'https://i2-prod.liverpoolecho.co.uk/article/example.jpg';
const initialUrl = 'https://cdn-images-1.medium.com/max/1024/1*SzapuwhysObdfvnB2Es4rw.png';
const resolvedUrl = 'https://cdn-images-1.medium.com/v2/resize:fit:1024/1*SzapuwhysObdfvnB2Es4rw.png';

function sequentialFetcher(responses: Response[], requested: string[]): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    requested.push(String(input));
    const response = responses.shift();
    if (!response) throw new Error('unexpected_fetch');
    return response;
  }) as typeof fetch;
}

function redirectResponse(location: string): Response {
  return { status: 301, headers: new Headers({ Location: location }), body: null } as Response;
}

async function redirectFailure(location: string): Promise<void> {
  const requested: string[] = [];
  const result = await fetchRemotePreviewImage(initialUrl, openaq, new AbortController().signal,
    sequentialFetcher([redirectResponse(location)], requested));
  assert.equal(result.response, null);
  assert.equal(result.failure, 'redirect', location);
  assert.deepEqual(requested, [initialUrl]);
}

assert.equal(remotePreviewUrl(initialUrl, openaq), initialUrl);
assert.equal(remotePreviewUrl(resolvedUrl, openaq), resolvedUrl);
assert.equal(remotePreviewUrl(cambridgeImageUrl, cambridgeNews), cambridgeImageUrl);
assert.equal(remotePreviewUrl(cambridgeImageUrl, unrelatedDynamicSource), null);
for (const rejected of [
  'http://i2-prod.liverpoolecho.co.uk/article/example.jpg',
  'https://user:pass@i2-prod.liverpoolecho.co.uk/article/example.jpg',
  'https://i2-prod.liverpoolecho.co.uk:443/article/example.jpg',
  'https://i2-prod.liverpoolecho.co.uk.attacker.example/article/example.jpg',
  'https://i3-prod.liverpoolecho.co.uk/article/example.jpg',
]) assert.equal(remotePreviewUrl(rejected, cambridgeNews), null, rejected);
const requested: string[] = [];
const success = await fetchRemotePreviewImage(initialUrl, openaq, new AbortController().signal,
  sequentialFetcher([
    new Response(null, { status: 301, headers: { Location: '/v2/resize:fit:1024/1*SzapuwhysObdfvnB2Es4rw.png' } }),
    new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/png' } }),
  ], requested));
assert.equal(success.response?.status, 200);
assert.equal(success.failure, null);
assert.deepEqual(requested, [initialUrl, resolvedUrl]);

const secondRedirectRequests: string[] = [];
const secondRedirect = await fetchRemotePreviewImage(initialUrl, openaq, new AbortController().signal,
  sequentialFetcher([
    new Response(null, { status: 301, headers: { Location: '/v2/resize:fit:1024/1*SzapuwhysObdfvnB2Es4rw.png' } }),
    new Response(null, { status: 302, headers: { Location: '/another-image.png' } }),
  ], secondRedirectRequests));
assert.equal(secondRedirect.response, null);
assert.equal(secondRedirect.failure, 'redirect');
assert.deepEqual(secondRedirectRequests, [initialUrl, resolvedUrl]);

for (const location of [
  'https://cdn-images-2.medium.com/image.png',
  'http://cdn-images-1.medium.com/image.png',
  'https://user:pass@cdn-images-1.medium.com/image.png',
  'https://cdn-images-1.medium.com:443/image.png',
  '//cdn-images-1.medium.com/image.png',
  'https://[invalid',
]) await redirectFailure(location);

const unrelatedRequests: string[] = [];
const unrelated = await fetchRemotePreviewImage(bbcImageUrl, bbc,
  new AbortController().signal, sequentialFetcher([
    new Response(null, { status: 301, headers: { Location: '/new-image.png' } }),
  ], unrelatedRequests));
assert.equal(unrelated.response, null);
assert.equal(unrelated.failure, 'redirect');
assert.deepEqual(unrelatedRequests, [bbcImageUrl]);

const directRequests: string[] = [];
const direct = await fetchRemotePreviewImage(bbcImageUrl, bbc,
  new AbortController().signal, sequentialFetcher([
    new Response(new Uint8Array([1]), { status: 200, headers: { 'Content-Type': 'image/png' } }),
  ], directRequests));
assert.equal(direct.response?.status, 200);
assert.equal(direct.failure, null);
assert.deepEqual(directRequests, [bbcImageUrl]);
console.log('Remote preview image checks passed');
