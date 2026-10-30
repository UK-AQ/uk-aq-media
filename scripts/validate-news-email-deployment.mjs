// Validate the selected settings; never infer or fall back to another environment.
// Environment selection relies on reviewed repository variables and secrets.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { httpsOrigin, websiteConfig } from '../apps/media-email/src/config.mjs';

export function validateNewsEmailDeployment(env = process.env) {
  if (typeof env.CLOUDFLARE_ACCOUNT_ID !== 'string' ||
      !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID) ||
      typeof env.UK_AQ_MEDIA_CFLARE_D1DB_ID !== 'string' ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(env.UK_AQ_MEDIA_CFLARE_D1DB_ID) ||
      env.UK_AQ_MEDIA_CFLARE_D1DB_ID === '00000000-0000-0000-0000-000000000000') {
    throw new Error('Missing or invalid Cloudflare account or D1 database');
  }
  websiteConfig(env);
  for (const key of ['SUPABASE_URL', 'NEWS_EMAIL_PUBLIC_API_ORIGIN', 'UK_AQ_MEDIA_PUBLIC_URL']) {
    httpsOrigin(env[key], key);
  }
  if (!new URL(env.SUPABASE_URL).hostname.endsWith('.supabase.co')) {
    throw new Error('SUPABASE_URL must point to a Supabase project');
  }
  if (!['true', 'false'].includes(env.NEWS_EMAIL_ENABLED)) throw new Error('Invalid NEWS_EMAIL_ENABLED');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateNewsEmailDeployment();
  console.log('Validated News email deployment settings.');
}
