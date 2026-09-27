import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HttpError } from '@uk-aq-media/core';
import {
  ArticleImagePolicyBody, SourceMutation, validateImagePolicyEvidence,
} from '../apps/media-admin/src/editorial-dashboard';

assert.equal(SourceMutation.safeParse({ image_policy: 'local_copy_permitted',
  permission_basis: 'Publisher licence recorded',
  confirm_local_copy_permitted: true }).success, true);
assert.equal(SourceMutation.safeParse({ permission_basis: 'Detached evidence' }).success, false);
assert.equal(SourceMutation.safeParse({ image_policy: 'local_copy_permitted',
  permission_basis: 'x'.repeat(1001), confirm_local_copy_permitted: true }).success, false);
assert.equal(ArticleImagePolicyBody.safeParse({ image_policy: 'blocked' }).success, true);
assert.equal(ArticleImagePolicyBody.safeParse({ image_policy: 'not-a-policy' }).success, false);
assert.throws(() => validateImagePolicyEvidence('local_copy_permitted', undefined, true),
  error => error instanceof HttpError && error.message === 'local_copy_permission_basis_required');
assert.throws(() => validateImagePolicyEvidence('local_copy_permitted', 'Permission recorded', false),
  error => error instanceof HttpError && error.message === 'local_copy_confirmation_required');
assert.equal(validateImagePolicyEvidence('local_copy_permitted', '  Permission recorded  ', true),
  'Permission recorded');

const source = readFileSync('apps/media-admin/src/editorial-dashboard.ts', 'utf8');
const sourceMutation = source.slice(source.indexOf('async function mutateSource'),
  source.indexOf('async function addSource'));
const articleMutation = source.slice(source.indexOf('async function setArticleImagePolicy'),
  source.indexOf('function localImageFailure'));
assert.doesNotMatch(sourceMutation, /UPDATE media_articles/,
  'source policy mutation must not bulk-update article rows');
assert.match(sourceMutation, /UPDATE media_sources SET publication_policy = \?, enabled = \?,\s+image_policy = \?/);
assert.match(sourceMutation, /INSERT INTO media_configuration_events/);
assert.match(sourceMutation, /previous_image_policy/);
assert.match(sourceMutation, /new_image_policy/);
assert.match(articleMutation, /admin:image-policy:/);
assert.match(articleMutation, /requiredArticleRevision\(request\)/);
assert.match(articleMutation, /source_local_copy_not_permitted/);
assert.match(articleMutation, /s\.image_policy = 'local_copy_permitted'/);
assert.match(articleMutation, /UPDATE media_articles SET image_policy = \?, mutation_key = \?,/);
assert.doesNotMatch(articleMutation, /og_image_url\s*=/);
assert.doesNotMatch(articleMutation, /status\s*=/);
assert.match(articleMutation, /INSERT INTO media_article_events/);
assert.match(articleMutation, /'edited', 'admin'/);
assert.match(articleMutation, /operation: 'image_policy'/);
assert.match(articleMutation, /evidence_only: !changed/);
assert.match(articleMutation, /a\.image_policy = 'local_copy_permitted'/,
  'legacy local-copy evidence refresh must be guarded by current article policy');

for (const migration of ['migrations/0001_media_core.sql', 'migrations/0008_media_dashboard_admin.sql']) {
  const sql = readFileSync(migration, 'utf8');
  assert.match(sql, /events_no_update/);
  assert.match(sql, /events_no_delete/);
}

console.log('Image policy admin checks passed');
