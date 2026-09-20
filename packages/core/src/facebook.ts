export const FACEBOOK_PAGE_ID = '1336337862891538';
export const FACEBOOK_PAGE_NAME = 'UK Air Quality - ukaq.co.uk';
export const FACEBOOK_TEMPLATE_MAX_LENGTH = 2000;
export const FACEBOOK_TITLE_MAX_LENGTH = 2000;
export const FACEBOOK_PUBLISHER_MAX_LENGTH = 500;
export const FACEBOOK_CANONICAL_URL_MAX_LENGTH = 2048;
export const FACEBOOK_PLACEHOLDERS = ['publisher'] as const;
export const DEFAULT_FACEBOOK_MESSAGE_TEMPLATE =
  'From {publisher}\n\nLive and historical UK air quality data:\nhttps://ukaq.co.uk/';

export const FACEBOOK_PUBLICATION_STATUSES = [
  'queued', 'posting', 'posted', 'failed', 'blocked', 'unknown_remote_state',
] as const;
export type FacebookPublicationStatus = typeof FACEBOOK_PUBLICATION_STATUSES[number];

export const FACEBOOK_PUBLICATION_REASONS = [
  'auto_approved', 'pending_approved', 'rejected_repost', 'unhidden_repost',
  'manual_post', 'manual_repost',
] as const;
export type FacebookPublicationReason = typeof FACEBOOK_PUBLICATION_REASONS[number];

export function validateFacebookTemplate(template: string): { literalCharacters: number } {
  if (typeof template !== 'string' || !template.trim() ||
      template.length > FACEBOOK_TEMPLATE_MAX_LENGTH) {
    throw new Error('message_template_invalid');
  }
  const withoutKnown = template.replace(/\{publisher\}/g, '');
  if (/\{[^{}]*\}/.test(withoutKnown) || withoutKnown.includes('{') || withoutKnown.includes('}')) {
    throw new Error('message_template_unknown_placeholder');
  }
  return { literalCharacters: withoutKnown.length };
}

function boundedRequired(value: string, maximum: number, error: string): string {
  if (typeof value !== 'string') throw new Error(error);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum) throw new Error(error);
  return trimmed;
}

export function renderFacebookPost(input: {
  title: string;
  publisher: string;
  canonical_url: string;
  template: string;
}): { message: string; link: string } {
  const title = boundedRequired(input.title, FACEBOOK_TITLE_MAX_LENGTH, 'post_title_invalid');
  const publisher = boundedRequired(
    input.publisher, FACEBOOK_PUBLISHER_MAX_LENGTH, 'post_publisher_invalid');
  const link = boundedRequired(
    input.canonical_url, FACEBOOK_CANONICAL_URL_MAX_LENGTH, 'post_link_invalid');
  let parsedLink: URL;
  try {
    parsedLink = new URL(link);
  } catch {
    throw new Error('post_link_invalid');
  }
  if (parsedLink.protocol !== 'https:' && parsedLink.protocol !== 'http:') {
    throw new Error('post_link_invalid');
  }
  const template = boundedRequired(
    input.template, FACEBOOK_TEMPLATE_MAX_LENGTH, 'message_template_invalid');
  validateFacebookTemplate(template);
  return {
    message: `${title}\n${template.replace(/\{publisher\}/g, publisher)}`,
    link,
  };
}

export type FacebookWakeup = { type: 'facebook_wakeup'; publication_id?: number };
export function isFacebookWakeup(value: unknown): value is FacebookWakeup {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return body.type === 'facebook_wakeup' && (body.publication_id === undefined ||
    Number.isSafeInteger(body.publication_id) && Number(body.publication_id) > 0) &&
    Object.keys(body).every(key => key === 'type' || key === 'publication_id');
}
