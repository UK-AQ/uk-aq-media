import { parse } from 'tldts';
import { publisherHostname } from './source-domain-blocks';

export const SYNDICATION_NORMALISATION = 'publisher-title-nfkc-v1';
export const SYNDICATION_INDEX_BATCH = 10;

// Exact metadata equality only. Keep words, negation, numbers and qualifiers;
// neither display titles nor publication dates participate in title matching.
export function normaliseSyndicationTitle(title: string): string | null {
  if (title.length > 2000) return null;
  const key = title.normalize('NFKC').toLowerCase()
    .replace(/[\u2018\u2019\u201b\u02bc]/gu, "'")
    .replace(/[\u201c\u201d\u201f]/gu, '"')
    .replace(/\p{Pd}/gu, '-')
    .replace(/(?<!\p{N})[.,:]|[.,:](?!\p{N})/gu, ' ')
    .replace(/[^\p{L}\p{M}\p{N}'"+%&/<>=?.,:\-\s]/gu, ' ')
    .replace(/\s*([\-'"/])\s*/gu, '$1')
    .replace(/\s+/gu, ' ').trim();
  return [...key].length >= 30 && key.length <= 1000 &&
    (key.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 5 ? key : null;
}

function publisherDomain(url: string): string {
  const host = publisherHostname(url);
  const result = parse(host, { allowPrivateDomains: true, extractHostname: false });
  return result.domain ?? host;
}

async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

type MetadataArticle = {
  id: number; title: string; canonical_url: string; canonical_url_hash: string;
  published_at: string | null;
};

// Call only with a bounded set of persisted identities. Read stored publisher
// metadata after persistence so direct-publisher precedence over GDELT is honoured.
export async function indexSyndicationArticles(db: D1Database,
  articles: readonly MetadataArticle[]): Promise<void> {
  if (articles.length > SYNDICATION_INDEX_BATCH) throw new Error('syndication_index_batch_too_large');
  const now = new Date().toISOString();
  for (const article of articles) {
    const normalised = normaliseSyndicationTitle(article.title);
    if (!normalised) continue;
    const domain = publisherDomain(article.canonical_url);
    const key = await sha256(`${SYNDICATION_NORMALISATION}:${normalised}`);
    const fingerprint = await sha256(JSON.stringify([article.title, article.canonical_url,
      article.canonical_url_hash, article.published_at, domain]));
    await db.batch([
      db.prepare(`INSERT INTO media_syndication_groups
        (title_key, normalised_title, created_at, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(title_key) DO NOTHING`)
        .bind(key, normalised, now, now),
      db.prepare(`INSERT INTO media_syndication_metadata
        (article_id, group_id, publisher_domain, fingerprint, indexed_at)
        SELECT a.id, g.id, ?, ?, ? FROM media_articles a, media_syndication_groups g
        WHERE a.id = ? AND a.title = ? AND a.canonical_url = ?
          AND a.canonical_url_hash = ? AND a.published_at IS ? AND g.title_key = ?
        ON CONFLICT(article_id) DO UPDATE SET group_id = excluded.group_id,
          publisher_domain = excluded.publisher_domain, fingerprint = excluded.fingerprint,
          revision = media_syndication_metadata.revision +
            CASE WHEN media_syndication_metadata.valid = 1 THEN 1 ELSE 0 END,
          valid = 1, indexed_at = excluded.indexed_at
        WHERE media_syndication_metadata.fingerprint <> excluded.fingerprint
          OR media_syndication_metadata.valid = 0`)
        .bind(domain, fingerprint, now, article.id, article.title, article.canonical_url,
          article.canonical_url_hash, article.published_at, key),
    ]);
  }
}

// Best effort derived state must never turn a committed discovery into a retry,
// failed editorial transition, or a new social/email publication decision.
export async function indexSyndicationHashes(db: D1Database, hashes: readonly string[]): Promise<boolean> {
  try {
    for (let start = 0; start < hashes.length; start += SYNDICATION_INDEX_BATCH) {
      const slice = hashes.slice(start, start + SYNDICATION_INDEX_BATCH);
      const { results } = await db.prepare(`SELECT id, title, canonical_url, canonical_url_hash,
        published_at FROM media_articles WHERE canonical_url_hash IN (SELECT value FROM json_each(?))
        ORDER BY id LIMIT ?`).bind(JSON.stringify(slice), SYNDICATION_INDEX_BATCH).all<MetadataArticle>();
      await indexSyndicationArticles(db, results);
    }
    return true;
  } catch {
    console.warn(JSON.stringify({ event: 'syndication_metadata_index_failed' }));
    return false;
  }
}

// Separately invoked authenticated admin population only. Keyset/high-water
// pagination is finite and safe to resume; deployment never invokes this path.
export async function populateSyndicationMetadata(db: D1Database, after: number, through: number):
Promise<{ next_after: number; through_id: number; complete: boolean; considered: number }> {
  const { results } = await db.prepare(`SELECT a.id, a.title, a.canonical_url,
    a.canonical_url_hash, a.published_at FROM media_articles a
    WHERE a.id > ? AND a.id <= ? ORDER BY a.id LIMIT ?`)
    .bind(after, through, SYNDICATION_INDEX_BATCH).all<MetadataArticle>();
  await indexSyndicationArticles(db, results);
  return { next_after: results.at(-1)?.id ?? through, through_id: through,
    complete: results.length < SYNDICATION_INDEX_BATCH || results.at(-1)?.id === through,
    considered: results.length };
}

// Trusted SQL expression only. Match both evidence revisions and the current
// preference epoch; never infer suppression transitively or via article status.
export function publicSyndicationVisibilitySql(article: string): string {
  return `NOT EXISTS (SELECT 1 FROM media_syndication_reviews sr
    JOIN media_syndication_groups sg ON sg.id = sr.group_id AND sg.epoch = sr.epoch
      AND sg.representative_article_id = sr.representative_article_id
    JOIN media_syndication_metadata sm ON sm.article_id = sr.article_id
      AND sm.group_id = sg.id AND sm.valid = 1 AND sm.revision = sr.member_metadata_revision
    JOIN media_syndication_metadata rm ON rm.article_id = sr.representative_article_id
      AND rm.group_id = sg.id AND rm.valid = 1 AND rm.revision = sr.representative_metadata_revision
    JOIN media_articles representative ON representative.id = sr.representative_article_id
    JOIN media_sources representative_source ON representative_source.source_key = representative.source_key
    WHERE sr.article_id = ${article}.id AND sr.suppress = 1
      AND sr.classification = 'confirmed_syndicated' AND representative.status = 'approved')`;
}
