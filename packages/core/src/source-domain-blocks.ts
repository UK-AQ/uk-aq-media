import { parse } from 'tldts';
import { HttpError } from './http';

// Host identity only: never a URL, wildcard, publisher name or company group.
export function normalisePublisherHostname(input: string): string {
  const host = input.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (host.length > 253 || host.split('.').length < 2 ||
      !host.split('.').every(label => label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new HttpError(400, 'invalid_publisher_domain');
  }
  return host;
}

export function normaliseBlockDomain(input: string): string {
  const host = normalisePublisherHostname(input);
  const parsed = parse(host, { allowPrivateDomains: true, extractHostname: false,
    validateHostname: true });
  if (!parsed.domain || parsed.isIp || !parsed.isIcann && !parsed.isPrivate) {
    throw new HttpError(400, 'publisher_domain_must_not_be_public_suffix');
  }
  return host;
}

export function publisherHostname(rawUrl: string): string {
  return normalisePublisherHostname(new URL(rawUrl).hostname);
}

// These SQL builders accept trusted code expressions, never request SQL.
export function normalisedHostnameSql(expression: string): string {
  const host = `lower(rtrim(${expression}, '.'))`;
  return `(CASE WHEN substr(${host}, 1, 4) = 'www.' THEN substr(${host}, 5) ELSE ${host} END)`;
}

export function publisherHostnameSql(urlExpression: string): string {
  const authority = `substr(${urlExpression}, instr(${urlExpression}, '://') + 3)`;
  const host = `substr(${authority}, 1, instr(${authority} || '/', '/') - 1)`;
  return normalisedHostnameSql(host);
}

export function domainBoundarySql(host: string, domain: string): string {
  return `(${host} = ${domain} OR substr(${host}, -length(${domain}) - 1) = '.' || ${domain})`;
}

export function domainBlockedSql(hostExpression: string): string {
  return `EXISTS (SELECT 1 FROM media_source_domain_blocks domain_block
    WHERE domain_block.blocked = 1 AND ${domainBoundarySql(hostExpression, 'domain_block.domain')})`;
}

// Validated ASCII hostnames can be used as SQL constants without consuming the
// GDELT chunk's bounded D1 parameter allowance. No user SQL is accepted here.
export function publisherAdmissionSql(urls: readonly string[]): string {
  const hosts = new Set(urls.map(publisherHostname));
  return [...hosts].map(host => `NOT ${domainBlockedSql(`'${host}'`)}`).join(' AND ');
}

export type SourceDomainBlock = {
  domain: string; blocked: number; reason: string | null;
  created_at: string; updated_at: string;
};

export async function findPublisherDomainBlock(db: D1Database, host: string):
Promise<SourceDomainBlock | null> {
  return db.prepare(`SELECT * FROM media_source_domain_blocks domain_block
    WHERE domain_block.blocked = 1 AND ${domainBoundarySql('?', 'domain_block.domain')}
    ORDER BY length(domain_block.domain) DESC LIMIT 1`)
    .bind(normalisePublisherHostname(host), normalisePublisherHostname(host))
    .first<SourceDomainBlock>();
}

export async function requirePublisherDomainAllowed(db: D1Database, rawUrl: string): Promise<void> {
  const block = await findPublisherDomainBlock(db, publisherHostname(rawUrl));
  if (block) throw new HttpError(409, `publisher_domain_blocked:${block.domain}`);
}

export async function blockedPublisherHosts(db: D1Database, hosts: readonly string[]): Promise<Set<string>> {
  const normalised = [...new Set(hosts.map(normalisePublisherHostname))];
  if (!normalised.length) return new Set();
  const { results } = await db.prepare(`SELECT host.value AS host FROM json_each(?) host
    WHERE ${domainBlockedSql('host.value')}`).bind(JSON.stringify(normalised))
    .all<{ host: string }>();
  return new Set(results.map(row => row.host));
}
