import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { normaliseDoi } from '@uk-aq-media/core';
import { handleResearchPublic } from '../apps/media-public/src/research';
import { handleResearchTopicsAdmin } from '../apps/media-admin/src/research-topics';

type SqlValue = string | number | bigint | null | Uint8Array;
class Statement {
  private params: SqlValue[] = [];
  constructor(private readonly stmt: StatementSync) {}
  bind(...params: unknown[]): D1PreparedStatement {
    this.params = params as SqlValue[];
    return this as unknown as D1PreparedStatement;
  }
  async first<T>(): Promise<T | null> {
    return (this.stmt.get(...this.params) as T | undefined) ?? null;
  }
  async all<T>(): Promise<D1Result<T>> {
    return { results: this.stmt.all(...this.params) as T[],
      success: true, meta: {} as D1Meta };
  }
  async run(): Promise<D1Result> {
    const result = this.stmt.run(...this.params);
    return { results: [], success: true,
      meta: { last_row_id: Number(result.lastInsertRowid), changes: result.changes } as D1Meta };
  }
}
class Db {
  constructor(readonly connection: DatabaseSync) {}
  prepare(sql: string): D1PreparedStatement {
    return new Statement(this.connection.prepare(sql)) as unknown as D1PreparedStatement;
  }
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const values: D1Result[] = [];
      for (const statement of statements) values.push(await statement.run());
      this.connection.exec('COMMIT');
      return values;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }
}

const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON;');
for (const filename of readdirSync('migrations').filter(v => /^\d+.*\.sql$/u.test(v)).sort()) {
  sqlite.exec(readFileSync(`migrations/${filename}`, 'utf8'));
}
const db = new Db(sqlite) as unknown as D1Database;
const base = 'https://media.example';
function admin(method: string, path: string, body?: unknown): Promise<Response | null> {
  return handleResearchTopicsAdmin(new Request(base + path, {
    method, ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }), new URL(base + path), db);
}
function pub(path: string): Promise<Response | null> {
  return handleResearchPublic(new Request(base + path), new URL(base + path), db);
}
async function responseJson(response: Response | null): Promise<Record<string, unknown>> {
  assert.ok(response, 'route recognised');
  return await response.json() as Record<string, unknown>;
}

assert.equal(normaliseDoi('https://doi.org/10.1234%2FMy.Study'), '10.1234/my.study');
assert.equal(normaliseDoi('DOI:10.1234/OTHER'), '10.1234/other');
assert.equal(normaliseDoi(null), null);
assert.throws(() => normaliseDoi('https://evil.example/10.1234/study'), /invalid_doi/);

const wood = await responseJson(await admin('POST', '/admin/topics', {
  slug: 'wood-burning', name: 'Wood Burning',
}));
const researchTopic = await responseJson(await admin('POST', '/admin/topics', {
  slug: 'source-apportionment', name: 'Source Apportionment',
}));
const woodId = Number(wood.id);
const researchTopicId = Number(researchTopic.id);
assert.ok(woodId > 0 && researchTopicId > 0);
const paper = await responseJson(await admin('POST', '/admin/research/papers', {
  canonical_title: 'Residential combustion and particulate pollution',
  authors: ['A Researcher'], first_published_at: '2026-10-01',
}));
const paperId = Number(paper.id);
assert.equal(paper.editorial_status, 'pending');
const preprint = await responseJson(await admin('POST',
  `/admin/research/papers/${paperId}/publications`, {
    version_type: 'preprint', doi: 'https://doi.org/10.1234/Preprint',
    publication_url: 'https://example.org/preprint', first_online_date: '2026-09-01',
  }));
const final = await responseJson(await admin('POST',
  `/admin/research/papers/${paperId}/publications`, {
    version_type: 'final', doi: 'doi:10.5678/Final',
    publication_url: 'https://example.org/final', first_online_date: '2026-10-01',
    issue_date: '2026-11-01',
  }));
assert.ok(Number(preprint.id) > 0 && Number(final.id) > 0);
assert.equal(final.doi, '10.5678/final');
const conflict = await admin('POST', `/admin/research/papers/${paperId}/publications`, {
  version_type: 'final', doi: 'HTTPS://DOI.ORG/10.5678/FINAL',
  publication_url: 'https://example.org/duplicate',
});
assert.equal(conflict?.status, 409);

const assigned = await responseJson(await admin('PUT', `/admin/research/papers/${paperId}/topics`, {
  topic_ids: [woodId, researchTopicId],
}));
assert.deepEqual(assigned.topic_ids, [woodId, researchTopicId]);
await admin('PATCH', `/admin/research/papers/${paperId}`, { editorial_status: 'approved' });
const list = await responseJson(await pub('/research/papers?topic=wood-burning'));
assert.equal((list.papers as unknown[]).length, 1);
assert.equal(((list.papers as Array<{ publications: unknown[] }>)[0]?.publications ?? []).length, 2);
const detail = await responseJson(await pub(`/research/papers/${paperId}`));
assert.equal((detail.related_news as unknown[]).length, 0);
const topics = await responseJson(await pub('/topics'));
assert.equal((topics.topics as Array<{slug:string,research_count:number}>)
  .find(value => value.slug === 'wood-burning')?.research_count, 1);

await admin('POST', `/admin/topics/${woodId}/merge`,
  { target_topic_id: researchTopicId });
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM topic_slug_aliases WHERE slug = ?')
  .get('wood-burning')?.n, 1);
const aliasResult = await responseJson(await pub('/research/papers?topic=wood-burning'));
assert.equal((aliasResult.papers as unknown[]).length, 1);
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM research_paper_topics WHERE paper_id = ?')
  .get(paperId)?.n, 1);

const child = await responseJson(await admin('POST', '/admin/topics',
  { slug: 'child-topic', name: 'Child Topic', parent_topic_id: researchTopicId }));
const cycle = admin('PATCH', `/admin/topics/${researchTopicId}`,
  { parent_topic_id: Number(child.id) });
await assert.rejects(cycle, /topic_parent_cycle/);

await admin('PATCH', `/admin/research/papers/${paperId}`, { editorial_status: 'hidden' });
assert.equal((await pub('/research/papers?topic=source-apportionment'))?.status, 200);
const afterHide = await responseJson(await pub('/research/papers?topic=source-apportionment'));
assert.equal((afterHide.papers as unknown[]).length, 0);
assert.equal((await pub(`/research/papers/${paperId}`))?.status, 404);
sqlite.close();
console.log('Research, DOI and topic catalogue checks passed');
