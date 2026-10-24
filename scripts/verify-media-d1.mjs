// Read-only ownership gate. Must run before Queue creation or D1 migrations.
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const dbId = process.env.UK_AQ_MEDIA_CFLARE_D1DB_ID ?? '';
const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
if (!/^[a-f0-9]{32}$/i.test(account) ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(dbId) || !token) {
  throw new Error('Missing Cloudflare account, D1 database or API token');
}
let response;
try {
  response = await fetch('https://api.cloudflare.com/client/v4/accounts/' +
    account + '/d1/database/' + dbId, {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(15000),
  });
} catch {
  throw new Error('Unable to verify the target Cloudflare D1 database');
}
let body;
try { body = await response.json(); } catch {
  throw new Error('Invalid Cloudflare D1 verification response');
}
if (!response.ok || body.success !== true ||
    body.result?.uuid?.toLowerCase() !== dbId.toLowerCase() ||
    body.result?.name !== 'uk-aq-media') {
  throw new Error('D1 database does not belong to the configured Cloudflare account or has an unexpected name');
}
console.log('Verified configured D1 database belongs to the selected Cloudflare account.');
