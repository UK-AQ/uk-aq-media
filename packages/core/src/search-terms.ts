const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'with',
]);

export const MAX_SEARCH_QUERY_CHARACTERS = 200;
export const MAX_BODY_HTML_BYTES = 256 * 1024;
export const MAX_ARTICLE_SEARCH_TERMS = 512;
const MAX_TERM_CHARACTERS = 64;

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"', copy: ' ', reg: ' ',
    ndash: '-', mdash: '-', hellip: ' ', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"',
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (_entity, key: string) => {
    if (!key.startsWith('#')) return named[key.toLowerCase()] ?? ' ';
    const hexadecimal = key[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(key.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    try { return Number.isSafeInteger(point) ? String.fromCodePoint(point) : ' '; }
    catch { return ' '; }
  });
}

export function meaningfulSearchTerms(value: string, maximum = MAX_ARTICLE_SEARCH_TERMS): string[] {
  const terms = value.normalize('NFKC').toLocaleLowerCase('en-GB')
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  return [...new Set(terms.filter(term => [...term].length <= MAX_TERM_CHARACTERS &&
    !STOP_WORDS.has(term)))].slice(0, maximum);
}

export function feedBodySearchTerms(html: string): string[] {
  const bounded = new TextDecoder().decode(new TextEncoder().encode(html)
    .slice(0, MAX_BODY_HTML_BYTES));
  const visible = bounded.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<!--[^]*?(?:-->|$)/g, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
  return meaningfulSearchTerms(decodeHtmlEntities(visible));
}

export function replaceArticleBodyTerms(db: D1Database, articleId: number,
  sourceKey: string, terms: string[]): Promise<unknown[]> {
  return db.batch([
    db.prepare('DELETE FROM media_article_search_terms WHERE article_id = ?').bind(articleId),
    db.prepare(`INSERT INTO media_article_search_terms (article_id, source_key, term)
      SELECT ?, ?, value FROM json_each(?)`).bind(articleId, sourceKey, JSON.stringify(terms)),
  ]);
}

export function deleteArticleBodyTerms(db: D1Database,
  selector: { article_id: number } | { source_key: string }): Promise<D1Result> {
  return 'article_id' in selector
    ? db.prepare('DELETE FROM media_article_search_terms WHERE article_id = ?')
      .bind(selector.article_id).run()
    : db.prepare('DELETE FROM media_article_search_terms WHERE source_key = ?')
      .bind(selector.source_key).run();
}
