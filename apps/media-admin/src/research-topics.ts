import { HttpError, json, normaliseDoi, TOPIC_SLUG_RE, z } from '@uk-aq-media/core';

const now = () => new Date().toISOString();
const PositiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Slug = z.string().min(1).max(100).regex(TOPIC_SLUG_RE);
const HttpUrl = z.url().max(2048).refine(value => /^https?:\/\//i.test(value));
const PublicationDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const EditableStatus = z.enum(['pending', 'approved', 'rejected', 'hidden']);
const TopicBase = z.object({
  slug: Slug,
  name: z.string().trim().min(1).max(150),
  description: z.string().max(2000).nullable().default(null),
  parent_topic_id: PositiveId.nullable().default(null),
  is_active: z.boolean().default(true),
  display_order: z.number().int().min(-100000).max(100000).default(0),
}).strict();
const TopicPatch = z.object({
  slug: Slug.optional(),
  name: z.string().trim().min(1).max(150).optional(),
  description: z.string().max(2000).nullable().optional(),
  parent_topic_id: PositiveId.nullable().optional(),
  is_active: z.boolean().optional(),
  display_order: z.number().int().min(-100000).max(100000).optional(),
}).strict().refine(value => Object.keys(value).length > 0);
const Strings = z.array(z.string().trim().min(1).max(500)).max(100);
const PaperBase = z.object({
  canonical_title: z.string().trim().min(1).max(1000),
  abstract: z.string().max(50000).nullable().default(null),
  authors: Strings.default([]),
  subjects: Strings.default([]),
  countries: Strings.default([]),
  canonical_paper_url: HttpUrl.nullable().default(null),
  open_access_url: HttpUrl.nullable().default(null),
  first_published_at: PublicationDate.nullable().default(null),
  discovered_from: z.string().max(250).nullable().default(null),
}).strict();
const PaperPatch = z.object({
  canonical_title: z.string().trim().min(1).max(1000).optional(),
  abstract: z.string().max(50000).nullable().optional(),
  authors: Strings.optional(),
  subjects: Strings.optional(),
  countries: Strings.optional(),
  canonical_paper_url: HttpUrl.nullable().optional(),
  open_access_url: HttpUrl.nullable().optional(),
  first_published_at: PublicationDate.nullable().optional(),
  discovered_from: z.string().max(250).nullable().optional(),
  editorial_status: EditableStatus.optional(),
}).strict().refine(value => Object.keys(value).length > 0);
const PublicationBase = z.object({
  version_type: z.enum(['preprint','accepted','final']),
  doi: z.string().max(2048).nullable().default(null),
  publication_url: HttpUrl,
  venue: z.string().max(300).nullable().default(null),
  publisher: z.string().max(300).nullable().default(null),
  first_online_date: PublicationDate.nullable().default(null),
  issue_date: PublicationDate.nullable().default(null),
  source_name: z.string().max(250).nullable().default(null),
}).strict();
const PublicationPatch = z.object({
  version_type: z.enum(['preprint','accepted','final']).optional(),
  doi: z.string().max(2048).nullable().optional(),
  publication_url: HttpUrl.optional(),
  venue: z.string().max(300).nullable().optional(),
  publisher: z.string().max(300).nullable().optional(),
  first_online_date: PublicationDate.nullable().optional(),
  issue_date: PublicationDate.nullable().optional(),
  source_name: z.string().max(250).nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0);
const TopicAssignments = z.object({
  topic_ids: z.array(PositiveId).max(50).refine(ids => new Set(ids).size === ids.length),
}).strict();
const PaperAssignments = z.object({
  links: z.array(z.object({
    paper_id: PositiveId,
    relationship: z.enum(['reports_on','cites','discusses','critiques']),
  }).strict()).max(50).refine(items =>
    new Set(items.map(item => item.paper_id)).size === items.length),
}).strict();
const MergeTopics = z.object({ target_topic_id: PositiveId }).strict();

async function readBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/json') throw new HttpError(415, 'json_content_type_required');
  const stated = Number(request.headers.get('content-length') ?? 0);
  if (stated > 64 * 1024) throw new HttpError(413, 'body_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'invalid_json');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) throw new HttpError(413, 'body_too_large');
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); }
    catch { /* stream may already be closed */ }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new HttpError(400, 'invalid_json'); }
  const valid = schema.safeParse(parsed);
  if (!valid.success) throw new HttpError(400, 'invalid_research_request');
  return valid.data;
}

async function exists(db: D1Database, table: 'topics' | 'media_articles' |
  'research_papers' | 'research_paper_publications', id: number): Promise<void> {
  const row = await db.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, 'record_not_found');
}

function idFromPath(raw: string | undefined): number {
  const id = Number(raw);
  if (!raw || !Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'invalid_id');
  return id;
}

async function topicConflicts(db: D1Database, slug: string | undefined,
  name: string | undefined, excluding: number | null = null): Promise<void> {
  if (slug) {
    const existing = await db.prepare(`SELECT id FROM topics WHERE slug = ?
      UNION SELECT topic_id AS id FROM topic_slug_aliases WHERE slug = ?`)
      .bind(slug, slug).all<{ id: number }>();
    if (existing.results.some(row => row.id !== excluding))
      throw new HttpError(409, 'topic_slug_conflict');
  }
  if (name) {
    const existing = await db.prepare('SELECT id FROM topics WHERE name = ?')
      .bind(name).first<{ id: number }>();
    if (existing && existing.id !== excluding) throw new HttpError(409, 'topic_name_conflict');
  }
}

async function topicAdmin(request: Request, url: URL, db: D1Database): Promise<Response | null> {
  if (url.pathname === '/admin/topics') {
    if (request.method === 'GET') {
      const { results } = await db.prepare('SELECT * FROM topics ORDER BY display_order, name').all();
      return json({ topics: results });
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const input = await readBody(request, TopicBase);
    await topicConflicts(db, input.slug, input.name);
    if (input.parent_topic_id !== null) await exists(db, 'topics', input.parent_topic_id);
    const result = await db.prepare(`INSERT INTO topics
      (slug, name, description, parent_topic_id, is_active, display_order)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(input.slug, input.name, input.description,
      input.parent_topic_id, Number(input.is_active), input.display_order).run();
    return json({ id: result.meta.last_row_id }, 201);
  }
  const match = /^\/admin\/topics\/([1-9]\d*)(?:\/(merge))?$/u.exec(url.pathname);
  if (!match) return null;
  const id = idFromPath(match[1]);
  await exists(db, 'topics', id);
  if (match[2] === 'merge') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const { target_topic_id: target } = await readBody(request, MergeTopics);
    if (target === id) throw new HttpError(409, 'cannot_merge_topic_into_itself');
    await exists(db, 'topics', target);
    const descendant = await db.prepare(`WITH RECURSIVE parents(id) AS (
      SELECT parent_topic_id FROM topics WHERE id = ?
      UNION SELECT t.parent_topic_id FROM topics t JOIN parents p ON t.id = p.id
        WHERE t.parent_topic_id IS NOT NULL
    ) SELECT id FROM parents WHERE id = ?`).bind(target, id).first();
    if (descendant) throw new HttpError(409, 'cannot_merge_into_descendant');
    const old = await db.prepare('SELECT slug FROM topics WHERE id = ?')
      .bind(id).first<{slug: string}>();
    if (!old) throw new HttpError(404, 'record_not_found');
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO media_article_topics
        (article_id, topic_id, assignment_source, created_at)
        SELECT article_id, ?, assignment_source, created_at FROM media_article_topics
        WHERE topic_id = ?`).bind(target, id),
      db.prepare(`INSERT OR IGNORE INTO research_paper_topics
        (paper_id, topic_id, assignment_source, created_at)
        SELECT paper_id, ?, assignment_source, created_at FROM research_paper_topics
        WHERE topic_id = ?`).bind(target, id),
      db.prepare('DELETE FROM media_article_topics WHERE topic_id = ?').bind(id),
      db.prepare('DELETE FROM research_paper_topics WHERE topic_id = ?').bind(id),
      db.prepare('UPDATE topics SET parent_topic_id = ?, updated_at = ? WHERE parent_topic_id = ?')
        .bind(target, now(), id),
      db.prepare('UPDATE topic_slug_aliases SET topic_id = ? WHERE topic_id = ?').bind(target, id),
      db.prepare('INSERT INTO topic_slug_aliases (slug, topic_id) VALUES (?, ?)')
        .bind(old.slug, target),
      db.prepare('DELETE FROM topics WHERE id = ?').bind(id),
    ]);
    return json({ merged: true, source_topic_id: id, target_topic_id: target });
  }
  if (request.method === 'GET') {
    const topic = await db.prepare('SELECT * FROM topics WHERE id = ?').bind(id).first();
    const aliases = await db.prepare('SELECT slug FROM topic_slug_aliases WHERE topic_id = ?')
      .bind(id).all();
    return json({ topic, aliases: aliases.results });
  }
  if (request.method !== 'PATCH') return json({ error: 'method_not_allowed' }, 405);
  const input = await readBody(request, TopicPatch);
  await topicConflicts(db, input.slug, input.name, id);
  if (input.parent_topic_id !== undefined && input.parent_topic_id !== null) {
    await exists(db, 'topics', input.parent_topic_id);
    if (input.parent_topic_id === id) throw new HttpError(409, 'topic_parent_cycle');
  }
  const changes: Record<string, unknown> = { ...input, updated_at: now() };
  if (input.is_active !== undefined) changes.is_active = Number(input.is_active);
  const columns = Object.keys(changes);
  // D1's migration statement splitter cannot safely apply a multi-statement
  // CREATE TRIGGER body. Prevent indirect topic cycles in the same atomic
  // UPDATE instead, including when two editors reparent concurrently.
  const guardedParent = input.parent_topic_id !== undefined && input.parent_topic_id !== null;
  const cycleGuard = guardedParent ? `AND NOT EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT ?
      UNION
      SELECT t.parent_topic_id FROM topics t JOIN ancestors a ON t.id = a.id
        WHERE t.parent_topic_id IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE id = ?
  )` : '';
  const result = await db.prepare(`UPDATE topics
    SET ${columns.map(column => `${column} = ?`).join(', ')}
    WHERE id = ? ${cycleGuard}`).bind(
      ...columns.map(column => changes[column]), id,
      ...(guardedParent ? [input.parent_topic_id, id] : []),
    ).run();
  if (guardedParent && result.meta.changes === 0) {
    throw new HttpError(409, 'topic_parent_cycle');
  }
  return json({ updated: true, id });
}

async function assignTopics(request: Request, db: D1Database, entityId: number,
  table: 'media_article_topics' | 'research_paper_topics',
  foreignKey: 'article_id' | 'paper_id', recordTable: 'media_articles' | 'research_papers')
  : Promise<Response> {
  await exists(db, recordTable, entityId);
  if (request.method === 'GET') {
    const { results } = await db.prepare(`SELECT t.*, link.assignment_source
      FROM ${table} link JOIN topics t ON t.id = link.topic_id
      WHERE link.${foreignKey} = ? ORDER BY t.display_order, t.name`).bind(entityId).all();
    return json({ topics: results });
  }
  if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
  const { topic_ids: ids } = await readBody(request, TopicAssignments);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const available = await db.prepare(`SELECT count(*) AS count FROM topics
      WHERE is_active = 1 AND id IN (${placeholders})`).bind(...ids).first<{count:number}>();
    if (available?.count !== ids.length) throw new HttpError(409, 'topic_not_active_or_missing');
  }
  const except = ids.length ? `AND topic_id NOT IN (${ids.map(() => '?').join(',')})` : '';
  const statements = [
    db.prepare(`DELETE FROM ${table} WHERE ${foreignKey} = ? ${except}`).bind(entityId, ...ids),
    ...ids.map(topicId => db.prepare(`INSERT INTO ${table}
      (${foreignKey}, topic_id, assignment_source) VALUES (?, ?, 'manual')
      ON CONFLICT(${foreignKey}, topic_id)
      DO UPDATE SET assignment_source = 'manual'`).bind(entityId, topicId)),
  ];
  await db.batch(statements);
  return json({ updated: true, topic_ids: ids });
}

async function linkedPapers(request: Request, db: D1Database, articleId: number)
  : Promise<Response> {
  await exists(db, 'media_articles', articleId);
  if (request.method === 'GET') {
    const { results } = await db.prepare(`SELECT p.id, p.canonical_title,
      p.editorial_status, link.relationship, link.provenance
      FROM media_article_research_papers link JOIN research_papers p ON p.id = link.paper_id
      WHERE link.article_id = ? ORDER BY p.id`).bind(articleId).all();
    return json({ papers: results });
  }
  if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
  const { links } = await readBody(request, PaperAssignments);
  for (const link of links) await exists(db, 'research_papers', link.paper_id);
  const ids = links.map(link => link.paper_id);
  const except = ids.length ? `AND paper_id NOT IN (${ids.map(() => '?').join(',')})` : '';
  await db.batch([
    db.prepare(`DELETE FROM media_article_research_papers
      WHERE article_id = ? ${except}`).bind(articleId, ...ids),
    ...links.map(link => db.prepare(`INSERT INTO media_article_research_papers
      (article_id, paper_id, relationship, provenance) VALUES (?, ?, ?, 'manual')
      ON CONFLICT(article_id, paper_id) DO UPDATE
        SET relationship = excluded.relationship, provenance = 'manual'`)
      .bind(articleId, link.paper_id, link.relationship)),
  ]);
  return json({ updated: true, links });
}

const paperColumns = {
  canonical_title: 'canonical_title',
  abstract: 'abstract',
  authors: 'authors_json',
  subjects: 'subjects_json',
  countries: 'countries_json',
  canonical_paper_url: 'canonical_paper_url',
  open_access_url: 'open_access_url',
  first_published_at: 'first_published_at',
  discovered_from: 'discovered_from',
  editorial_status: 'editorial_status',
} as const;

function paperChanges(input: Record<string, unknown>): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(paperColumns)) {
    if (field in input) changes[column] = ['authors','subjects','countries'].includes(field)
      ? JSON.stringify(input[field]) : input[field];
  }
  return changes;
}

async function papersAdmin(request: Request, url: URL, db: D1Database): Promise<Response | null> {
  if (url.pathname === '/admin/research/papers') {
    if (request.method === 'GET') {
      const status = url.searchParams.get('status');
      if (status !== null && !EditableStatus.safeParse(status).success)
        throw new HttpError(400, 'invalid_status');
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? 20 : Number(limitRaw);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        throw new HttpError(400, 'invalid_limit');
      const { results } = await db.prepare(`SELECT * FROM research_papers
        ${status ? 'WHERE editorial_status = ?' : ''}
        ORDER BY updated_at DESC, id DESC LIMIT ?`)
        .bind(...(status ? [status] : []), limit).all();
      return json({ papers: results });
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const input = await readBody(request, PaperBase);
    const v = paperChanges(input);
    const columns = Object.keys(v);
    const result = await db.prepare(`INSERT INTO research_papers
      (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .bind(...Object.values(v)).run();
    return json({ id: result.meta.last_row_id, editorial_status: 'pending' }, 201);
  }
  const pubUpdate = /^\/admin\/research\/publications\/([1-9]\d*)$/u.exec(url.pathname);
  if (pubUpdate) {
    const id = idFromPath(pubUpdate[1]);
    await exists(db, 'research_paper_publications', id);
    if (request.method !== 'PATCH') return json({ error: 'method_not_allowed' }, 405);
    const input = await readBody(request, PublicationPatch);
    const fields: Record<string, unknown> = { ...input, updated_at: now() };
    if ('doi' in fields) {
      fields.doi_normalized = normaliseDoi(fields.doi as string | null);
      delete fields.doi;
      if (fields.doi_normalized) {
        const match = await db.prepare('SELECT id FROM research_paper_publications WHERE doi_normalized = ? AND id <> ?')
          .bind(fields.doi_normalized, id).first();
        if (match) throw new HttpError(409, 'doi_already_registered');
      }
    }
    const columns = Object.keys(fields);
    await db.prepare(`UPDATE research_paper_publications SET
      ${columns.map(column => `${column} = ?`).join(', ')} WHERE id = ?`)
      .bind(...Object.values(fields), id).run();
    return json({ updated: true, id });
  }
  const paperMatch = /^\/admin\/research\/papers\/([1-9]\d*)(?:\/(topics|publications))?$/u.exec(url.pathname);
  if (!paperMatch) return null;
  const id = idFromPath(paperMatch[1]);
  if (paperMatch[2] === 'topics')
    return assignTopics(request, db, id, 'research_paper_topics', 'paper_id', 'research_papers');
  await exists(db, 'research_papers', id);
  if (paperMatch[2] === 'publications') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const input = await readBody(request, PublicationBase);
    const doi = normaliseDoi(input.doi);
    if (doi) {
      const existing = await db.prepare('SELECT id FROM research_paper_publications WHERE doi_normalized = ?')
        .bind(doi).first();
      if (existing) throw new HttpError(409, 'doi_already_registered');
    }
    const result = await db.prepare(`INSERT INTO research_paper_publications
      (paper_id, version_type, doi_normalized, publication_url, venue, publisher,
       first_online_date, issue_date, source_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, input.version_type, doi,
      input.publication_url, input.venue, input.publisher,
      input.first_online_date, input.issue_date, input.source_name).run();
    return json({ id: result.meta.last_row_id, doi }, 201);
  }
  if (request.method === 'GET') {
    const paper = await db.prepare('SELECT * FROM research_papers WHERE id = ?')
      .bind(id).first();
    const [publications, topics, news] = await Promise.all([
      db.prepare('SELECT * FROM research_paper_publications WHERE paper_id = ? ORDER BY id')
        .bind(id).all(),
      db.prepare(`SELECT t.*, pt.assignment_source FROM research_paper_topics pt
        JOIN topics t ON t.id = pt.topic_id WHERE pt.paper_id = ? ORDER BY t.name`)
        .bind(id).all(),
      db.prepare(`SELECT a.id, a.title, a.status, link.relationship FROM
        media_article_research_papers link JOIN media_articles a ON a.id = link.article_id
        WHERE link.paper_id = ? ORDER BY a.id DESC`).bind(id).all(),
    ]);
    return json({ paper, publications: publications.results, topics: topics.results,
      related_news: news.results });
  }
  if (request.method !== 'PATCH') return json({ error: 'method_not_allowed' }, 405);
  const input = await readBody(request, PaperPatch);
  const changes = { ...paperChanges(input), updated_at: now() };
  const columns = Object.keys(changes);
  await db.prepare(`UPDATE research_papers SET
    ${columns.map(column => `${column} = ?`).join(', ')} WHERE id = ?`)
    .bind(...Object.values(changes), id).run();
  return json({ updated: true, id });
}

export async function handleResearchTopicsAdmin(request: Request, url: URL,
  db: D1Database): Promise<Response | null> {
  if (url.pathname.startsWith('/admin/topics')) return topicAdmin(request, url, db);
  const articleTopic = /^\/admin\/articles\/([1-9]\d*)\/topics$/u.exec(url.pathname);
  if (articleTopic) {
    return assignTopics(request, db, idFromPath(articleTopic[1]),
      'media_article_topics', 'article_id', 'media_articles');
  }
  const articlePapers = /^\/admin\/articles\/([1-9]\d*)\/research-papers$/u.exec(url.pathname);
  if (articlePapers) return linkedPapers(request, db, idFromPath(articlePapers[1]));
  if (url.pathname.startsWith('/admin/research/')) return papersAdmin(request, url, db);
  return null;
}
