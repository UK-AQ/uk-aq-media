import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  localCopyPolicyPermitted, storeLocalImage, validateLocalImageBytes,
} from '@uk-aq-media/core';
import { loadThumbnail } from '../apps/media-discovery/src/bluesky';
import { publicPreviewImageUrl } from '../apps/media-public/src/index';

const jpeg = await validateLocalImageBytes(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg');
const png = await validateLocalImageBytes(
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png');
const webp = await validateLocalImageBytes(
  new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
  'image/webp');
assert.equal(jpeg.extension, 'jpg');
assert.equal(png.extension, 'png');
assert.equal(webp.extension, 'webp');
await assert.rejects(validateLocalImageBytes(png.bytes, 'image/jpeg'), /image_signature_mismatch/);
await assert.rejects(validateLocalImageBytes(new Uint8Array([0x3c, 0x73, 0x76, 0x67]),
  'image/svg+xml'), /invalid_image_content_type/);

assert.equal(localCopyPolicyPermitted({ og_image_url: 'https://publisher.example/image.jpg',
  article_image_policy: 'local_copy_permitted', source_image_policy: 'local_copy_permitted' }), true);
assert.equal(localCopyPolicyPermitted({ og_image_url: 'https://publisher.example/image.jpg',
  article_image_policy: 'remote_preview', source_image_policy: 'local_copy_permitted' }), false);
assert.equal(localCopyPolicyPermitted({ og_image_url: 'https://publisher.example/image.jpg',
  article_image_policy: 'local_copy_permitted', source_image_policy: 'remote_preview' }), false);
const localContentHash = 'a'.repeat(64);
assert.equal(await publicPreviewImageUrl('https://media.example', {
  id: 7, source_key: 'publisher', og_image_url: 'https://publisher.example/image.jpg',
  article_image_policy: 'local_copy_permitted', source_image_policy: 'local_copy_permitted',
  local_image_source_url: 'https://publisher.example/image.jpg',
  local_image_content_sha256: localContentHash,
}), `https://media.example/article-images/7?v=${'a'.repeat(32)}`);
assert.equal(await publicPreviewImageUrl('https://media.example', {
  id: 7, source_key: 'publisher', og_image_url: 'https://publisher.example/changed.jpg',
  article_image_policy: 'local_copy_permitted', source_image_policy: 'local_copy_permitted',
  local_image_source_url: 'https://publisher.example/image.jpg',
  local_image_content_sha256: localContentHash,
}), null);

let r2Writes = 0;
await assert.rejects(storeLocalImage({} as D1Database, {
  put: async () => { r2Writes++; return {} as R2Object; },
} as unknown as R2Bucket, {
  articleId: 1, articleRevision: 0, sourceImageUrl: 'https://publisher.example/image.jpg',
  articleImagePolicy: 'remote_preview', sourceImagePolicy: 'remote_preview', image: jpeg,
  acquisitionMethod: 'publisher_fetch',
}), /local_copy_not_permitted/);
assert.equal(r2Writes, 0, 'remote_preview must fail before any R2 write');

let publisherFetches = 0;
let imageInfoReads = 0;
let imageTransforms = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => { publisherFetches++; throw new Error('unexpected_fetch'); }) as typeof fetch;
try {
  // A landscape image below Bluesky's byte limit must use its original R2 bytes.
  // Simulate only the free Images.info inspection; no transformation is permitted.
  const thumbnail = await loadThumbnail({
    MEDIA_IMAGES: { get: async () => ({ arrayBuffer: async () => png.bytes.slice().buffer }) },
    IMAGES: {
      info: async () => { imageInfoReads++; return { width: 1600, height: 900 }; },
      input: () => { imageTransforms++; throw new Error('unexpected_image_transform'); },
    },
  } as unknown as MediaDiscoveryEnv, {
    id: 7, revision: 2, canonical_url: 'https://publisher.example/story', title: 'Story',
    publisher: 'Publisher', og_image_url: 'https://publisher.example/image.png',
    image_policy: 'local_copy_permitted', source_key: 'publisher',
    canonical_domain: 'publisher.example', source_image_policy: 'local_copy_permitted',
    social_handle: null, social_did: null,
    local_image_object_key: 'article-images/7/hash.png',
    local_image_source_url: 'https://publisher.example/image.png',
    local_image_content_type: 'image/png',
  });
  assert.equal(thumbnail.type, 'image/png');
  assert.deepEqual(new Uint8Array(thumbnail.bytes), png.bytes,
    'a correctly sized 16:9 thumbnail must retain the original image bytes');
  assert.equal(imageInfoReads, 1, 'Images.info must inspect the thumbnail once');
  assert.equal(imageTransforms, 0, 'an already suitable thumbnail must not be transformed');
  assert.equal(publisherFetches, 0, 'a valid retained local image must prevent publisher re-fetch');
} finally { globalThis.fetch = originalFetch; }

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const storageSource = readFileSync(join(root, 'packages/core/src/local-image.ts'), 'utf8');
assert.ok(storageSource.indexOf('await bucket.put(') < storageSource.indexOf('await db.batch('),
  'R2 must be written before the authoritative D1 pointer batch');
const blueskySource = readFileSync(join(root, 'apps/media-discovery/src/bluesky.ts'), 'utf8');
assert.match(blueskySource, /MEDIA_IMAGES\.get\(article\.local_image_object_key\)/);
assert.match(blueskySource, /storeLocalImage\(env\.MEDIA_DB, env\.MEDIA_IMAGES/);

for (const worker of ['media-admin', 'media-public', 'media-discovery']) {
  const config = readFileSync(join(root, `apps/${worker}/wrangler.jsonc`), 'utf8');
  assert.match(config, /"binding": "MEDIA_IMAGES"/);
  assert.match(config, /"bucket_name": "uk-aq-media-images"/);
}
console.log('Local image checks passed');
