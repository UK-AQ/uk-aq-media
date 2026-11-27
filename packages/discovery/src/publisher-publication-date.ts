import { z } from '@uk-aq-media/core';

const ISO_DATE = z.iso.date();
const ISO_INSTANT = z.iso.datetime({ offset: true, local: false });
const ISO_LOCAL_DATETIME = z.iso.datetime({ local: true });

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

export function writtenPublisherPublicationDate(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const dayFirst = /^(\d{1,2})\s+([a-z]+),?\s+(\d{4})$/.exec(value);
  const monthFirst = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(value);
  const day = dayFirst?.[1] ?? monthFirst?.[2];
  const month = MONTHS.indexOf(dayFirst?.[2] ?? monthFirst?.[1] ?? '') + 1;
  const year = dayFirst?.[3] ?? monthFirst?.[3];
  if (!day || !month || !year || year === '0000') return null;
  const date = `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
  return ISO_DATE.safeParse(date).success && date <= new Date().toISOString().slice(0, 10)
    ? date : null;
}

export function publisherPublicationDate(raw: string | null): string | null {
  if (!raw) return null;
  if (ISO_DATE.safeParse(raw).success) return raw;
  if (!ISO_INSTANT.safeParse(raw).success) {
    // The publisher specified a calendar date but supplied no timezone.
    return ISO_LOCAL_DATETIME.safeParse(raw).success ? raw.slice(0, 10) : writtenPublisherPublicationDate(raw);
  }
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
