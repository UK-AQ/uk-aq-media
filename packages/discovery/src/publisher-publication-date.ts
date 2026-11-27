import { z } from '@uk-aq-media/core';

const ISO_DATE = z.iso.date();
const ISO_INSTANT = z.iso.datetime({ offset: true, local: false });
const ISO_LOCAL_DATETIME = z.iso.datetime({ local: true });

export function publisherPublicationDate(raw: string | null): string | null {
  if (!raw) return null;
  if (ISO_DATE.safeParse(raw).success) return raw;
  if (!ISO_INSTANT.safeParse(raw).success) {
    // The publisher specified a calendar date but supplied no timezone.
    return ISO_LOCAL_DATETIME.safeParse(raw).success ? raw.slice(0, 10) : null;
  }
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
