// Fill account-specific Wrangler bindings in the workflow working copy only.
// Committed configs deliberately contain non-deployable values, not LIVE defaults.
import { readFileSync, writeFileSync } from 'node:fs';
import { httpsOrigin, websiteConfig } from '../apps/media-email/src/config.mjs';
import { validateNewsEmailDeployment } from './validate-news-email-deployment.mjs';

const mode = process.argv[2];
if (mode !== 'core' && mode !== 'email') {
  throw new Error('Usage: node scripts/render-wrangler-config.mjs core|email');
}
const placeholder = '00000000-0000-0000-0000-000000000000';
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const dbId = process.env.UK_AQ_MEDIA_CFLARE_D1DB_ID ?? '';
if (!/^[a-f0-9]{32}$/i.test(account)) {
  throw new Error('Missing or invalid UK_AQ_MEDIA_CLOUDFLARE_ACCOUNT_ID');
}
if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(dbId) ||
    dbId === placeholder) {
  throw new Error('Missing or invalid UK_AQ_MEDIA_CFLARE_D1DB_ID');
}

function required(name) {
  const value = process.env[name]?.trim() ?? '';
  if (!value || value.startsWith('REPLACE_')) throw new Error('Missing '+ name);
  return value;
}
function originVariable(name) {
  return httpsOrigin(process.env[name], name);
}

let emailVars = null;
if (mode === 'email') {
  validateNewsEmailDeployment();
  const enabled = required('NEWS_EMAIL_ENABLED');
  if (enabled !== 'true' && enabled !== 'false') throw new Error('Invalid NEWS_EMAIL_ENABLED');
  const { site, hostnames } = websiteConfig(process.env);
  const supabase = originVariable('SUPABASE_URL');
  if (!new URL(supabase).hostname.endsWith('.supabase.co')) {
    throw new Error('SUPABASE_URL must point to a Supabase project');
  }
  emailVars = {
    NEWS_EMAIL_ENABLED: enabled,
    NEWS_EMAIL_SITE_ORIGIN: site,
    NEWS_EMAIL_TURNSTILE_HOSTNAMES: hostnames.join(','),
    NEWS_EMAIL_PUBLIC_API_ORIGIN: originVariable('NEWS_EMAIL_PUBLIC_API_ORIGIN'),
    UK_AQ_MEDIA_PUBLIC_URL: originVariable('UK_AQ_MEDIA_PUBLIC_URL'),
    SUPABASE_URL: supabase,
  };
}

const paths = ['public', 'admin', 'discovery', 'email']
  .map(name => 'apps/media-' + name + '/wrangler.jsonc');
const updates = [];
for (const path of paths) {
  const text = readFileSync(path, 'utf8');
  // Our committed configs contain only optional whole-line JSONC comments.
  const config = JSON.parse(text.replace(/^\s*\/\/[^\n]*\n/gm, ''));
  if (config.name !== 'uk-aq-media-' + path.split('/')[1].slice(6) ||
      !Array.isArray(config.d1_databases) || config.d1_databases.length !== 1 ||
      config.d1_databases[0].binding !== 'MEDIA_DB' ||
      config.d1_databases[0].database_name !== 'uk-aq-media' ||
      ![placeholder, dbId].includes(config.d1_databases[0].database_id)) {
    throw new Error('Unexpected Wrangler D1 configuration in ' + path);
  }
  config.d1_databases[0].database_id = dbId;
  if (mode === 'email' && path === 'apps/media-email/wrangler.jsonc') {
    for (const [key, value] of Object.entries(emailVars)) {
      if (!(key in config.vars)) throw new Error('Missing email Wrangler key: ' + key);
      config.vars[key] = value;
    }
  }
  updates.push([path, JSON.stringify(config, null, 2) + '\n']);
}
for (const [path, contents] of updates) writeFileSync(path, contents);
console.log('Rendered ' + paths.length + ' Wrangler configurations for the selected Cloudflare account.');
