export const BLUESKY_HANDLE = 'ukaq.co.uk';
export const BLUESKY_POST_GRAPHEMES = 300;
export const BLUESKY_POST_BYTES = 3000;
export const BLUESKY_TEMPLATE_LITERAL_GRAPHEMES = 120;
export const BLUESKY_THUMBNAIL_BYTES = 1_000_000;
export const BLUESKY_PLACEHOLDERS = ['publisher', 'publisher_mention'] as const;
export const DEFAULT_BLUESKY_MESSAGE =
  'From {publisher} {publisher_mention}\n\nLive and historical UK air quality data:\nhttps://ukaq.co.uk/';

const segmenter = new Intl.Segmenter('en-GB', { granularity: 'grapheme' });

export function graphemes(value: string): string[] {
  return [...segmenter.segment(value)].map(part => part.segment);
}

export function validateBlueskyTemplate(template: string): { literalGraphemes: number } {
  if (!template || template.length > 2000) throw new Error('message_template_invalid');
  const withoutKnown = template.replace(/\{(?:publisher|publisher_mention)\}/g, '');
  if (/\{[^{}]*\}/.test(withoutKnown) || withoutKnown.includes('{') || withoutKnown.includes('}')) {
    throw new Error('message_template_unknown_placeholder');
  }
  if ((template.match(/\{publisher_mention\}/g) ?? []).length > 1) {
    throw new Error('message_template_multiple_mentions');
  }
  const literalGraphemes = graphemes(withoutKnown).length;
  if (literalGraphemes > BLUESKY_TEMPLATE_LITERAL_GRAPHEMES) {
    throw new Error('message_template_too_long');
  }
  return { literalGraphemes };
}

export type BlueskyFacet = {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: 'app.bsky.richtext.facet#link'; uri: string } |
    { $type: 'app.bsky.richtext.facet#mention'; did: string }>;
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function renderBlueskyPost(input: { title: string; publisher: string;
  template: string; publisherMention?: { handle: string; did: string } | null }):
  { text: string; facets: BlueskyFacet[] } {
  validateBlueskyTemplate(input.template);
  const mention = input.publisherMention?.handle ? `@${input.publisherMention.handle}` : '';
  let expanded = input.template.replaceAll('{publisher}', input.publisher);
  const mentionToken = '{publisher_mention}';
  const mentionTemplateIndex = expanded.indexOf(mentionToken);
  expanded = expanded.replace(mentionToken, mention);
  if (!mention) expanded = expanded.split('\n').map(line => line.replace(/[ \t]+$/g, '')).join('\n');
  const separator = '\n\n';
  const remaining = BLUESKY_POST_GRAPHEMES - graphemes(separator + expanded).length;
  if (remaining < 1) throw new Error('post_text_too_long');
  const titleParts = graphemes(input.title.trim());
  if (!titleParts.length) throw new Error('post_text_too_long');
  const title = titleParts.length <= remaining ? titleParts.join('')
    : remaining === 1 ? '…' : `${titleParts.slice(0, remaining - 1).join('')}…`;
  const text = `${title}${separator}${expanded}`;
  if (graphemes(text).length > BLUESKY_POST_GRAPHEMES || utf8Length(text) > BLUESKY_POST_BYTES) {
    throw new Error('post_text_too_long');
  }

  const facets: BlueskyFacet[] = [];
  const add = (start: number, raw: string, feature: BlueskyFacet['features'][number]) => {
    facets.push({ index: { byteStart: utf8Length(text.slice(0, start)),
      byteEnd: utf8Length(text.slice(0, start + raw.length)) }, features: [feature] });
  };
  for (const match of text.matchAll(/https:\/\/[^\s]+/g)) {
    add(match.index, match[0], { $type: 'app.bsky.richtext.facet#link', uri: match[0] });
  }
  if (mention && input.publisherMention && mentionTemplateIndex >= 0) {
    const start = title.length + separator.length + mentionTemplateIndex;
    if (text.slice(start, start + mention.length) === mention) add(start, mention,
      { $type: 'app.bsky.richtext.facet#mention', did: input.publisherMention.did });
  }
  return { text, facets: facets.sort((a, b) => a.index.byteStart - b.index.byteStart) };
}

// AT Protocol TIDs are 64-bit values encoded as 13 s32 characters. The high
// 53 bits are microseconds and the low 10 bits are a clock id. Persisting this
// value before createRecord makes an at-least-once retry address the same record.
const S32 = '234567abcdefghijklmnopqrstuvwxyz';
export function deterministicTid(createdAt: string, publicationId: number): string {
  const millis = Date.parse(createdAt);
  if (!Number.isFinite(millis) || !Number.isSafeInteger(publicationId) || publicationId < 1) {
    throw new Error('publication_state_conflict');
  }
  let value = BigInt(millis) * 1000n * 1024n + BigInt(publicationId % 1024);
  let result = '';
  for (let index = 0; index < 13; index++) {
    result = S32[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

export type BlueskyWakeup = { type: 'bluesky_wakeup'; publication_id?: number };
export function isBlueskyWakeup(value: unknown): value is BlueskyWakeup {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return body.type === 'bluesky_wakeup' && (body.publication_id === undefined ||
    Number.isSafeInteger(body.publication_id) && Number(body.publication_id) > 0) &&
    Object.keys(body).every(key => key === 'type' || key === 'publication_id');
}
