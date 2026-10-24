// Rebuild the shared inline assets after changing any approved email PNG.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const specifications = [
  ['heading', 'UK-AQ-NEWS-1line-email-w900.png', 'aq-in-the-news@ukaq.co.uk'],
  ['logo', 'UK-AQ-Logo-v3-2Lines-email.png', 'uk-aq-logo@ukaq.co.uk'],
  ['divider', 'UK-AQ-NEWS-gradient-divider-email-w900.png', 'aq-in-the-news-divider@ukaq.co.uk'],
];
const assets = Object.fromEntries(specifications.map(([key, filename, content_id]) => {
  const bytes = readFileSync(new URL(`images/${filename}`, root));
  if (bytes.length > 60000 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    throw new Error(`Invalid or oversized email PNG: ${filename}`);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 1000 || height > 1000)
    throw new Error(`Invalid email PNG dimensions: ${filename}`);
  return [key, { filename, content_id, width, height, base64: bytes.toString('base64') }];
}));
const output = new URL('images/news-email-branding.json', root);
const serialized = `${JSON.stringify(assets, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== serialized)
    throw new Error('Inline branding is stale; run node scripts/news-email-branding.mjs');
  console.log('Email branding matches both approved PNG files.');
} else {
  writeFileSync(output, serialized);
  console.log(`Updated ${fileURLToPath(output)}`);
}
